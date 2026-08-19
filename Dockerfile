FROM python:3.13-slim
WORKDIR /app
COPY . /app
RUN mkdir -p /app/data
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8080"]
