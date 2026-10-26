# =============================================================================
# Dockerfile — Imagem da API (BFF) para DESENVOLVIMENTO
# -----------------------------------------------------------------------------
# O QUE: Instala dependências e executa a API em modo watch (hot reload).
# POR QUE: Roda TypeScript direto via `tsx` (esbuild), sem etapa de build,
#          tornando o ciclo editar -> recarregar praticamente instantâneo.
# O código-fonte (./src) NÃO é copiado: ele chega via bind mount no compose.
# =============================================================================

# Node 24 LTS em Alpine: imagem pequena e versão com suporte de longo prazo.
FROM node:24-alpine

# Diretório de trabalho padrão dentro do container.
WORKDIR /app

# Copiamos SOMENTE os manifestos primeiro para aproveitar o cache de camadas:
# as dependências só são reinstaladas quando package*.json mudar.
COPY package.json package-lock.json* ./

# `npm ci` gera instalação determinística a partir do lockfile.
# Incluímos devDependencies (tsx, nodemon, typescript) pois é ambiente de dev.
RUN npm ci

# Configuração do TypeScript (também montada via volume no compose).
COPY tsconfig.json ./

# Porta HTTP/WebSocket da API (documentação; o mapeamento real é no compose).
EXPOSE 3000

# Usuário não-root já existente na imagem oficial: reduz riscos mesmo em dev.
USER node

# nodemon com --legacy-watch (polling) + tsx: hot reload confiável em bind
# mounts vindos de Windows/macOS, onde eventos inotify não chegam ao container.
CMD ["npm", "run", "dev:docker"]
