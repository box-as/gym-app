FROM python:3.12-slim

ENV PORT=8000 DATA_DIR=/data PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY server.py /app/server.py
COPY public/ /app/public/
EXPOSE 8000
CMD ["python3", "/app/server.py"]
