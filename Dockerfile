FROM python:3.13-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends bash nano git curl ca-certificates procps sudo build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend backend
COPY dist dist
ENV HOME=/home/pi TERM=xterm-256color
EXPOSE 4180
CMD ["python3", "backend/server.py"]
