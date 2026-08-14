FROM node:22-slim

# yt-dlp للاستخراج، ffmpeg للدمج وفكّ تشفير HLS، chromium لمستخرِج الشبكة
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip ffmpeg chromium ca-certificates \
      fonts-liberation fonts-noto-core fonts-noto-cjk \
 && pip3 install --break-system-packages --no-cache-dir -U yt-dlp \
 && apt-get purge -y python3-pip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

ENV CHROME_BIN=/usr/bin/chromium \
    HOST=0.0.0.0 \
    NO_OPEN=1 \
    DAWN_DIR=/data

WORKDIR /app
COPY package.json server.js sniffer.js ./
COPY public ./public

# مجلد التحميلات — يُربط به قرص دائم من المنصّة، وإلا مُسحت الملفات مع كل نشر
# (Railway لا تدعم تعليمة VOLUME؛ القرص يُربط من إعدادات الخدمة)
RUN mkdir -p /data

EXPOSE 5178
CMD ["node", "server.js"]
