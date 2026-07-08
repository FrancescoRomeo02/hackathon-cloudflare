FROM node:22-bookworm-slim

WORKDIR /workspace

COPY package*.json ./
RUN npm install

COPY . .

ENV CLOUDFLARE_ACCOUNT_ID=049fa0c83d44ab59a466b059664cedca

CMD ["npm", "run", "wrangler", "--", "--version"]
