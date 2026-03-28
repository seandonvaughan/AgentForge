#!/usr/bin/env bash
set -e
echo "Building AgentForge v5 packages..."
cd packages/shared && npx tsc --build && echo "✓ shared"
cd ../core && npx tsc --build && echo "✓ core"
cd ../db && npx tsc --build && echo "✓ db"
cd ../embeddings && npx tsc --build && echo "✓ embeddings"
cd ../plugins-sdk && npx tsc --build && echo "✓ plugins-sdk"
cd ../server && npx tsc --build && echo "✓ server"
cd ../cli && npx tsc --build && echo "✓ cli"
echo ""
echo "All v5 packages built successfully"
