package wsh_test

// ┌───────────────────────────────────────┬───────────────────────────────────────────────────┐
// │ Test                                  │ Description                                       │
// ├───────────────────────────────────────┼───────────────────────────────────────────────────┤
// │ TestCLI                               │ CLI subcommands                                   │
// │  ├ version                            │ wsh version prints version                        │
// │  ├ rpc missing port                   │ wsh rpc without WSH_RPC_PORT → error              │
// │  ├ rpc async via CLI                  │ wsh rpc --async succeeds                          │
// │  ├ rpc sync eval via CLI              │ wsh rpc eval 42 → "42"                            │
// │  ├ ls                                 │ wsh ls runs without error                         │
// │  └ new                                │ wsh new bash returns session URL                  │
// └───────────────────────────────────────┴───────────────────────────────────────────────────┘

import (
	"fmt"
	"testing"
)

func TestCLI(t *testing.T) {
	srv := startServer(t)

	t.Run("version", func(t *testing.T) {
		out := runCLI(t, "version")
		assertContains(t, out, "v0.")
	})

	t.Run("rpc missing port", func(t *testing.T) {
		_, err := runCLIErr(nil, "rpc", "eval", "1")
		if err == nil {
			t.Fatal("expected error")
		}
		assertContains(t, err.Error(), "WSH_RPC_PORT")
	})

	t.Run("rpc async via CLI", func(t *testing.T) {
		out := runCLIWithEnv(t, map[string]string{
			"WSH_RPC_PORT": fmt.Sprintf("%d", srv.port),
		}, "rpc", "--async", "log", "hello")
		_ = out
	})

	t.Run("rpc sync eval via CLI", func(t *testing.T) {
		browser := srv.connectRPCClient(t)
		browser.handleRPC(func(msg rpcMessage) *rpcResult {
			return evalJS(msg.Args[0])
		})

		out := runCLIWithEnv(t, map[string]string{
			"WSH_RPC_PORT": fmt.Sprintf("%d", srv.port),
		}, "rpc", "--timeout", "5000", "eval", "42")
		assertEqual(t, out, "42\n")
	})

	t.Run("ls", func(t *testing.T) {
		out := runCLIWithEnv(t, map[string]string{
			"WSH_PORT": fmt.Sprintf("%d", srv.port),
		}, "ls")
		_ = out
	})

	t.Run("new", func(t *testing.T) {
		out := runCLIWithEnv(t, map[string]string{
			"WSH_PORT": fmt.Sprintf("%d", srv.port),
		}, "new", "bash")
		assertContains(t, out, "bash#")
	})
}
