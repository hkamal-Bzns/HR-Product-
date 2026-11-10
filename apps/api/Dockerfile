FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
RUN npm install --workspaces --if-present
RUN npm run build --workspace=@hr-payroll/shared && npm run build --workspace=@hr-payroll/db && npm run build --workspace=@hr-payroll/api
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api
EXPOSE 3001
CMD ["node", "apps/api/dist/src/index.js"]
