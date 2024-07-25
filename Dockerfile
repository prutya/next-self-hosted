# The base image
FROM node:20.16.0-bookworm-slim AS base



# The "dependencies" stage
# It's good to install dependencies in a separate stage to be explicit about
# the files that make it into production stage
FROM base AS deps

# Enable Corepack so that pnpm can be installed
RUN corepack enable pnpm

# The application directory
WORKDIR /app

# Copy fiels for package management
COPY package.json pnpm-lock.yaml ./

# Install packages
RUN pnpm install --frozen-lockfile



# The final image
FROM base AS production

# Enable Corepack so that pnpm can be installed
RUN corepack enable pnpm

# Create a group and a non-root user to run the app
RUN groupadd --gid 1001 "nodejs"
RUN useradd --uid 1001 --create-home --shell /bin/bash --groups "nodejs" "nextjs"

# The application directory
WORKDIR /app

# Make sure that the .next directory exists
RUN mkdir -p /app/.next && chown -R nextjs:nodejs /app

# Copy node_modules from the dependencies stage
COPY --from=deps --chown=nextjs:nodejs /app/node_modules /app/node_modules

# Copy the rest of the application files
COPY --chown=nextjs:nodejs . .

# Enable production mode
ENV NODE_ENV=production

# Disable Next.js telemetry
ENV NEXT_TELEMETRY_DISABLED=1

# Configure application port
ENV PORT=3000

# Let image users know what port the app is going to listen on
EXPOSE 3000

# Change the user
USER nextjs:nodejs

# Make sure dependencies are picked up correctly
RUN pnpm install --frozen-lockfile
