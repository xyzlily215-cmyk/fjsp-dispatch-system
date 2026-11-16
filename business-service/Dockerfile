# 运行时镜像：jar 在本地用 mvn -DskipTests package 构建后再打包，
# 避免在低内存云服务器（2G）上跑 Maven 构建导致 OOM。
FROM eclipse-temurin:17-jre

# 图形验证码在 headless JVM 中仍需要可用字体。
RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY target/business-service-1.0.0.jar app.jar

EXPOSE 8081
ENTRYPOINT ["java", "-jar", "app.jar"]
