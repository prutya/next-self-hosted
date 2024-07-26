#!/usr/bin/env bash

set -exo pipefail

# Build and run the latest version of the app
docker compose --file docker-compose.production.yml up --build --detach nginx

# Remove the unused containers
docker system prune --force
