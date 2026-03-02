#!/bin/bash
sudo tee /usr/local/bin/devbash > /dev/null << 'EOF'
#!/bin/bash
if [ $# -eq 0 ]; then
  docker exec -it devbox bash
else
  docker exec devbox bash -c "$*"
fi
EOF
sudo chmod +x /usr/local/bin/devbash
echo "devbash installed successfully."
