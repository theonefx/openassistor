# OpenAssistor 扩展镜像
# 基于 openclaw-base 镜像，添加插件和配置

FROM openassistor/openclaw-base:latest

# 切换回 root 用户以复制文件
USER root

# 复制项目文件到工作目录
COPY . /app

# 创建 OpenClaw 配置目录（如果不存在）
RUN mkdir -p /root/.openclaw

# 复制插件到 OpenClaw 插件目录
RUN mkdir -p /root/.openclaw/extensions/schedule-manager && \
    cp -r /app/extensions/schedule-manager/* /root/.openclaw/extensions/schedule-manager/

# 复制配置文件
RUN cp /app/openclaw.json /root/.openclaw/openclaw.json

# 复制环境变量模板
RUN cp /app/.env.example /root/.openclaw/.env

# 创建数据目录（使用 node 用户的 home 目录）
RUN mkdir -p /home/node/.openassistor/schedule/daily && \
    mkdir -p /home/node/.openassistor/schedule/weekly && \
    mkdir -p /home/node/.openassistor/schedule/weekly/archived

# 设置权限
RUN chown -R node:node /root/.openclaw /home/node/.openassistor

# 切换回 node 用户
USER node

# 暴露默认端口（如果使用 gateway）
EXPOSE 8080

# 启动 OpenClaw
CMD ["openclaw"]