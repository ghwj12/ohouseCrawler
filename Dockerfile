# 1. 베이스 이미지 선택 (Node.js 공식 이미지)
FROM node:18

# 2. OS 패키지 설치 (Puppeteer가 필요로 하는 라이브러리)
RUN apt-get update && apt-get install -y \
    libnss3 \
    libatk1.0-0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
  && rm -rf /var/lib/apt/lists/*

# 3. 작업 디렉토리 설정
WORKDIR /app

# 4. package.json 및 package-lock.json 복사 후 의존성 설치
COPY package*.json ./
RUN npm install --production

# 5. 애플리케이션 코드 전체 복사
COPY . .

# 6. (선택) 환경변수나 빌드 스크립트가 필요하면 여기서 실행
# ENV NODE_ENV=production

# 7. 컨테이너가 외부에 오픈할 포트
EXPOSE 3000

# 8. 컨테이너 시작 명령
CMD ["node", "ohouse_final_app.js"]