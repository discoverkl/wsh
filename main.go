package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed dist public node_modules package.json
var appFiles embed.FS

const nodeVer = "v20.19.0"

// appVer is set at build time: go build -ldflags "-X main.appVer=v1.0.0"
var appVer = "dev"

func main() {
	cache, err := cacheDir()
	if err != nil {
		dieWithHints("Cannot create cache directory", err, []string{
			"Check that your home directory is writable",
			"Try: chmod 755 ~",
		})
	}

	nodeBin, err := ensureNode(cache)
	if err != nil {
		dieWithHints("Node.js setup failed", err, nodeHints(err))
	}

	appDir, err := ensureApp(cache)
	if err != nil {
		dieWithHints("App setup failed", err, []string{
			"Check available disk space",
			"Try: rm -rf ~/.wsh/app/ and re-run wsh",
		})
	}

	serverJS := filepath.Join(appDir, "dist", "server.js")
	os.Exit(runServer(nodeBin, serverJS, os.Args[1:]))
}

func nodeHints(err error) []string {
	msg := err.Error()
	if strings.Contains(msg, "checksum") {
		return []string{
			"The downloaded file may be corrupted — try again",
			"Force a fresh download: rm -rf ~/.wsh/node/ and re-run wsh",
		}
	}
	if strings.Contains(msg, "extract") {
		return []string{
			"Check available disk space (Node.js requires ~150 MB)",
			"Force a fresh download: rm -rf ~/.wsh/node/ and re-run wsh",
		}
	}
	return []string{
		"Check your internet connection",
		"If behind a proxy, set: HTTPS_PROXY=http://your-proxy:port",
		"nodejs.org may be temporarily unavailable — try again",
	}
}

// ---- Terminal output ----

var (
	clBold   = "\033[1m"
	clDim    = "\033[2m"
	clReset  = "\033[0m"
	clRed    = "\033[31m"
	clGreen  = "\033[32m"
	clYellow = "\033[33m"
	clCyan   = "\033[36m"
)

func init() {
	if os.Getenv("NO_COLOR") != "" || os.Getenv("TERM") == "dumb" {
		clBold, clDim, clReset, clRed, clGreen, clYellow, clCyan = "", "", "", "", "", "", ""
	}
}

func printStep(msg string) {
	fmt.Printf("  %s→%s  %s\n", clYellow, clReset, msg)
}

func printDone(msg string) {
	fmt.Printf("  %s✓%s  %s\n", clGreen+clBold, clReset, msg)
}

func dieWithHints(msg string, err error, hints []string) {
	fmt.Fprintf(os.Stderr, "\n  %s✗  %s%s\n", clRed+clBold, clReset+clBold, msg)
	fmt.Fprintf(os.Stderr, "     %s%v%s\n", clDim, err, clReset)
	if len(hints) > 0 {
		fmt.Fprintf(os.Stderr, "\n  %sSuggestions:%s\n", clBold, clReset)
		for _, h := range hints {
			fmt.Fprintf(os.Stderr, "     %s•  %s%s\n", clDim, h, clReset)
		}
	}
	fmt.Fprintln(os.Stderr)
	os.Exit(1)
}

// ---- Cache directory ----

func cacheDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".wsh")
	return dir, os.MkdirAll(dir, 0755)
}

// ---- Node.js management ----

func nodeOS() string {
	switch runtime.GOOS {
	case "darwin":
		return "darwin"
	case "linux":
		return "linux"
	case "windows":
		return "win"
	default:
		return runtime.GOOS
	}
}

func nodeArch() string {
	if runtime.GOARCH == "amd64" {
		return "x64"
	}
	return runtime.GOARCH // arm64 matches as-is
}

func nodeDirName() string {
	return fmt.Sprintf("node-%s-%s-%s", nodeVer, nodeOS(), nodeArch())
}

func nodeArchiveExt() string {
	if runtime.GOOS == "windows" {
		return ".zip"
	}
	return ".tar.gz"
}

// ensureNode ensures the pinned Node.js version is cached and returns the path to its binary.
func ensureNode(cache string) (string, error) {
	nodeDir := filepath.Join(cache, "node", nodeDirName())

	var binPath string
	if runtime.GOOS == "windows" {
		binPath = filepath.Join(nodeDir, "node.exe")
	} else {
		binPath = filepath.Join(nodeDir, "bin", "node")
	}

	if _, err := os.Stat(binPath); err == nil {
		return binPath, nil
	}

	fmt.Printf("\n  %s◆  First run — wsh needs to download Node.js%s\n", clCyan+clBold, clReset)
	fmt.Printf("     %sNode.js %s (~30 MB) will be cached in ~/.wsh and reused on every future run.%s\n\n", clDim, nodeVer, clReset)

	filename := nodeDirName() + nodeArchiveExt()
	downloadURL := fmt.Sprintf("https://nodejs.org/dist/%s/%s", nodeVer, filename)
	sumsURL := fmt.Sprintf("https://nodejs.org/dist/%s/SHASUMS256.txt", nodeVer)

	printStep(fmt.Sprintf("Downloading Node.js %s...", nodeVer))
	tmp, err := os.CreateTemp("", "wsh-node-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())

	if err := downloadTo(tmp, downloadURL); err != nil {
		tmp.Close()
		return "", fmt.Errorf("download: %w", err)
	}
	tmp.Close()

	printStep("Verifying checksum...")
	if err := verifySHA256(tmp.Name(), filename, sumsURL); err != nil {
		return "", fmt.Errorf("checksum: %w", err)
	}

	printStep("Extracting...")
	if err := os.MkdirAll(nodeDir, 0755); err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		if err := extractZip(tmp.Name(), nodeDir); err != nil {
			return "", fmt.Errorf("extract: %w", err)
		}
	} else {
		if err := extractTarGz(tmp.Name(), nodeDir); err != nil {
			return "", fmt.Errorf("extract: %w", err)
		}
	}

	printDone(fmt.Sprintf("Node.js %s ready\n", nodeVer))
	return binPath, nil
}

// isExecutableAppFile reports whether an embedded app file needs the execute bit.
// node-pty's spawn-helper must be executable, as must any native .node addon.
func isExecutableAppFile(path string) bool {
	base := filepath.Base(path)
	return filepath.Ext(base) == ".node" || base == "spawn-helper"
}

// ---- App file extraction ----

// ensureApp extracts embedded app files to the cache directory.
// Re-extracts only when appVer changes.
func ensureApp(cache string) (string, error) {
	appDir := filepath.Join(cache, "app", appVer)
	versionFile := filepath.Join(appDir, ".version")

	if data, err := os.ReadFile(versionFile); err == nil && strings.TrimSpace(string(data)) == appVer {
		return appDir, nil
	}

	fmt.Printf("\n  %s◆  Setting up wsh %s%s\n", clCyan+clBold, appVer, clReset)
	fmt.Printf("     %sExtracting app files — this only happens once per version.%s\n\n", clDim, clReset)

	printStep("Extracting app files...")
	if err := os.RemoveAll(appDir); err != nil {
		return "", err
	}

	if err := fs.WalkDir(appFiles, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == "." {
			return err
		}
		dest := filepath.Join(appDir, filepath.FromSlash(path))
		if d.IsDir() {
			return os.MkdirAll(dest, 0755)
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return err
		}
		data, err := appFiles.ReadFile(path)
		if err != nil {
			return err
		}
		perm := fs.FileMode(0644)
		if isExecutableAppFile(path) {
			perm = 0755
		}
		return os.WriteFile(dest, data, perm)
	}); err != nil {
		return "", err
	}

	if err := os.WriteFile(versionFile, []byte(appVer), 0644); err != nil {
		return "", err
	}

	printDone(fmt.Sprintf("wsh %s ready\n", appVer))
	return appDir, nil
}

// ---- Server execution ----

// runServer starts the Node.js server process and waits for it to exit.
// Forwards os.Interrupt to the child so Ctrl+C is handled gracefully.
func runServer(nodeBin, serverJS string, args []string) int {
	cmd := exec.Command(nodeBin, append([]string{serverJS}, args...)...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		dieWithHints("Failed to start server", err, []string{
			"Check if port 3000 is already in use: lsof -i :3000",
			"Try a different port: wsh --port 3001",
		})
	}

	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt)
	go func() {
		for s := range ch {
			_ = cmd.Process.Signal(s)
		}
	}()

	err := cmd.Wait()
	signal.Stop(ch)
	close(ch)

	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			return exit.ExitCode()
		}
		return 1
	}
	return 0
}

// ---- Download helpers ----

func downloadTo(w io.Writer, url string) error {
	resp, err := http.Get(url) //nolint:gosec
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	_, err = io.Copy(w, resp.Body)
	return err
}

func verifySHA256(filePath, filename, sumsURL string) error {
	resp, err := http.Get(sumsURL) //nolint:gosec
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	sums, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var expected string
	for _, line := range strings.Split(string(sums), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[1] == filename {
			expected = fields[0]
			break
		}
	}
	if expected == "" {
		return fmt.Errorf("no checksum found for %s", filename)
	}

	f, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if actual != expected {
		return fmt.Errorf("checksum mismatch (want %s, got %s)", expected, actual)
	}
	return nil
}

// ---- Archive extraction ----

// stripFirstComponent removes the leading directory segment from an archive path.
// "node-v20.0.0-darwin-arm64/bin/node" → "bin/node"
func stripFirstComponent(p string) string {
	p = filepath.ToSlash(p)
	if idx := strings.Index(p, "/"); idx >= 0 {
		return p[idx+1:]
	}
	return ""
}

// safe returns dest only if it is safely inside destDir (guards against path traversal).
func safe(destDir, rel string) string {
	dest := filepath.Join(destDir, filepath.FromSlash(rel))
	if !strings.HasPrefix(dest, filepath.Clean(destDir)+string(os.PathSeparator)) {
		return ""
	}
	return dest
}

func extractTarGz(src, destDir string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		rel := stripFirstComponent(hdr.Name)
		if rel == "" {
			continue
		}
		dest := safe(destDir, rel)
		if dest == "" {
			continue
		}

		switch hdr.Typeflag {
		case tar.TypeDir:
			os.MkdirAll(dest, 0755)
		case tar.TypeReg:
			os.MkdirAll(filepath.Dir(dest), 0755)
			out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, hdr.FileInfo().Mode())
			if err != nil {
				return err
			}
			_, err = io.Copy(out, tr)
			out.Close()
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			os.Remove(dest)
			os.MkdirAll(filepath.Dir(dest), 0755)
			os.Symlink(hdr.Linkname, dest) //nolint:errcheck
		}
	}
	return nil
}

func extractZip(src, destDir string) error {
	r, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer r.Close()

	for _, f := range r.File {
		rel := stripFirstComponent(f.Name)
		if rel == "" {
			continue
		}
		dest := safe(destDir, rel)
		if dest == "" {
			continue
		}

		if f.FileInfo().IsDir() {
			os.MkdirAll(dest, 0755)
			continue
		}

		os.MkdirAll(filepath.Dir(dest), 0755)
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.Create(dest)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		out.Close()
		rc.Close()
		if err != nil {
			return err
		}
	}
	return nil
}
