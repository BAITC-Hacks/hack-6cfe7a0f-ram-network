FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && useradd --system --uid 10001 --create-home firebird \
    && mkdir -p /data && chown firebird:firebird /data
COPY server.py index.html Firebird.html ai-config.json *.css *.js ./
USER firebird
ENV PYTHONUNBUFFERED=1 FIREBIRD_DATABASE=/data/firebird.sqlite3 FIREBIRD_BIND=0.0.0.0 PORT=4173
EXPOSE 4173
CMD ["python", "server.py", "serve"]
