#!/bin/bash
set -e
npm install
npm run build
chmod +x dist/cli/index.js
npm link

# Install shell completion (auto-detects shell)
echo "Installing shell completions..."
clawdult completion install
