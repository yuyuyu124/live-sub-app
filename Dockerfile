# 直播订阅 · 免费托管 Docker 镜像
# 纯 Node 内置模块，无第三方依赖，镜像极小
FROM node:20-alpine

WORKDIR /app

# 复制应用文件
COPY package.json ./
COPY server.js ./
COPY public ./public

# 运行端口（Render/Koyeb 等平台会通过 PORT 环境变量注入）
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
