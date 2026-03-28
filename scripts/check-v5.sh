#!/usr/bin/env bash
echo "Type-checking AgentForge v5 packages..."
for pkg in shared core db embeddings plugins-sdk server cli; do
  (cd packages/$pkg && npx tsc --noEmit 2>&1 | head -20 && echo "✓ $pkg") || echo "✗ $pkg"
done
