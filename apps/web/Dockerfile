FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm install --workspaces --if-present
RUN npm run build --workspace=@hr-payroll/web
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/apps/web/dist ./dist
RUN npm install -g serve@14
EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
