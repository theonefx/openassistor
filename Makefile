# OpenAssistor Makefile
# 构建和运行 OpenAssistor Docker 容器的便捷入口（多阶段构建）

# 基础镜像名称
BASE_IMAGE_NAME := openassistor/openclaw-base
# 扩展镜像名称
IMAGE_NAME := openassistor
# 容器名称
CONTAINER_NAME := openassistor

# 默认目标
.PHONY: help
help:
	@echo "OpenAssistor Makefile 命令:"
	@echo ""
	@echo "  make build-base   - 构建基础 Docker 镜像 (openclaw-base)"
	@echo "  make build        - 构建扩展 Docker 镜像 (openassistor)"
	@echo "  make build-all    - 构建所有镜像"
	@echo "  make run          - 运行容器（需要先有 .env 文件）"
	@echo "  make up           - 使用 docker-compose 启动服务"
	@echo "  make down         - 停止并移除 docker-compose 服务"
	@echo "  make logs         - 查看容器日志"
	@echo "  make clean        - 清理构建产物"
	@echo "  make env          - 创建 .env 文件模板"
	@echo ""
	@echo "环境变量:"
	@echo "  BASE_IMAGE_NAME=$(BASE_IMAGE_NAME)"
	@echo "  IMAGE_NAME=$(IMAGE_NAME)"
	@echo "  CONTAINER_NAME=$(CONTAINER_NAME)"

# 检查 .env 文件是否存在
check-env:
	@if [ ! -f ".env" ]; then \
		echo "错误: 找不到 .env 文件!"; \
		echo "请先运行 'make env' 创建模板，然后编辑填入您的 API 密钥"; \
		exit 1; \
	fi

# 构建基础 Docker 镜像
.PHONY: build-base
build-base:
	docker build -t $(BASE_IMAGE_NAME):latest -f docker/Dockerfile.base .

# 构建扩展 Docker 镜像
.PHONY: build
build: build-base
	docker build -t $(IMAGE_NAME):latest -f docker/Dockerfile .

# 构建所有镜像
.PHONY: build-all
build-all: build-base build

# 运行容器（直接使用 docker run）
.PHONY: run
run: check-env build
	docker run -it --rm \
		--name $(CONTAINER_NAME) \
		--env-file .env \
		-v $(shell pwd)/data:/home/node/.openassistor/schedule \
		$(IMAGE_NAME):latest

# 使用 docker-compose 启动服务
.PHONY: up
up: check-env
	docker-compose -f docker/docker-compose.yml up -d

# 停止并移除 docker-compose 服务
.PHONY: down
down:
	docker-compose -f docker/docker-compose.yml down

# 查看容器日志
.PHONY: logs
logs:
	@if docker ps -q --filter "name=$(CONTAINER_NAME)" | grep -q .; then \
		docker logs -f $(CONTAINER_NAME); \
	elif docker-compose -f docker/docker-compose.yml ps -q | grep -q .; then \
		docker-compose -f docker/docker-compose.yml logs -f; \
	else \
		echo "没有运行中的容器。请先运行 'make run' 或 'make up'"; \
	fi

# 创建 .env 文件模板
.PHONY: env
env:
	@if [ ! -f ".env" ]; then \
		cp .env.example .env; \
		echo "已创建 .env 文件模板，请编辑并填入您的 API 密钥"; \
	else \
		echo ".env 文件已存在，跳过创建"; \
	fi

# 清理构建产物
.PHONY: clean
clean:
	@if docker images -q $(IMAGE_NAME) | grep -q .; then \
		docker rmi $(IMAGE_NAME):latest; \
		echo "已删除镜像 $(IMAGE_NAME):latest"; \
	else \
		echo "镜像 $(IMAGE_NAME):latest 不存在，无需清理"; \
	fi
	@if docker images -q $(BASE_IMAGE_NAME) | grep -q .; then \
		docker rmi $(BASE_IMAGE_NAME):latest; \
		echo "已删除镜像 $(BASE_IMAGE_NAME):latest"; \
	else \
		echo "镜像 $(BASE_IMAGE_NAME):latest 不存在，无需清理"; \
	fi
	@if [ -d "data" ]; then \
		echo "注意: data 目录包含持久化数据，如需清理请手动删除"; \
	fi
