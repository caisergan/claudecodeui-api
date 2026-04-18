#!/bin/bash
echo "🛑 Stopping any existing instances on ports 3005 and 5173..."
# Kill processes using ports 3005 (API) and 5173 (Client)
if command -v lsof >/dev/null 2>&1; then
    lsof -ti:3005,5173 | xargs kill -9 2>/dev/null || true
fi

echo "📥 Pulling latest changes from git..."
git pull

echo "📦 Installing any new dependencies..."
npm install

echo "🚀 Starting the project..."
# Using 'npm start' based on package.json which runs build && server.
npm start
