FROM node:20-bookworm-slim

# sharp 0.33 自带预编译 libvips 二进制，无需系统安装；
# fonts-dejavu + fonts-wqy-zenhei 用于标注 PNG 上的数字与中文标签
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fonts-dejavu-core \
      fonts-wqy-zenhei \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖（利用 Docker 层缓存）
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# 拷贝应用代码
COPY server ./server
COPY shared ./shared
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data \
    MAX_UPLOAD_MB=50

RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8080

# 容器启动即自动建库建表（server/db.js 中的 IF NOT EXISTS），完成数据初始化
CMD ["node", "server/index.js"]
