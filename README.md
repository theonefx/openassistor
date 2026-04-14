# OpenAssistor

OpenAssistor 是一个基于 [OpenClaw](https://github.com/openclaw/openclaw) 扩展机制构建的**个人 AI 秘书**。

不修改、不拷贝 OpenClaw 源码，完全通过 OpenClaw 的插件系统和配置能力实现秘书定位：

1. **工作与日程管理** — 统一管理工作任务和日历事件，支持每日规划/更新/确认工作流
2. **工作总结与规划** — 生成每日/每周工作总结，协助制定工作计划
3. **知识学习与沉淀** — 从对话中自动积累知识，支持语义检索（使用 OpenClaw 自带的 memory 插件）
4. **外部协助工作** — 对接外部系统辅助工作（规划中）

---

## Docker 部署

OpenAssistor 采用**多阶段 Docker 构建**架构，将基础依赖和扩展配置分离：

- **基础镜像** (`Dockerfile.base`): 包含 OpenClaw CLI 和运行时依赖
- **扩展镜像** (`Dockerfile`): 基于基础镜像，添加 OpenAssistor 插件和配置

### 1. 准备环境变量

首先，创建环境变量文件并填写您的 API 密钥：

```bash
make env
# 编辑 .env 文件，填入您的 API key
```

OpenAssistor 支持多种模型提供商：

- **Qwen (通义千问)** - 默认首选模型 (`qwen/qwen-plus`)
- **Anthropic (Claude)** - 备用模型
- **OpenAI (GPT)** - 备用模型

### Qwen 完整配置

Qwen 支持三个关键配置参数：

1. **API Key**: `QWEN_API_KEY` - 您的 DashScope API 密钥
2. **Endpoint**: `QWEN_ENDPOINT` - Qwen API 的 endpoint URL
3. **Model**: 在 `openclaw.json` 中配置的模型名称

在 `.env` 文件中配置 Qwen：

```env
# Qwen API 配置（推荐）
QWEN_API_KEY=sk-您的-dashscope-api-key
QWEN_ENDPOINT=https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation
# QWEN_MODEL=qwen-plus  # 模型在 openclaw.json 中配置

# 或者 Anthropic API 密钥
# ANTHROPIC_API_KEY=sk-ant-...

# 或者 OpenAI API 密钥  
# OPENAI_API_KEY=sk-...
```

> **注意**: 模型名称 (`qwen-plus`, `qwen-max`, `qwen-turbo` 等) 在 `openclaw.json` 的 `agents.list[0].model.primary` 字段中配置。如果您需要更改模型，请编辑该文件。

默认配置使用 `qwen/qwen-plus`，您可以通过修改 `openclaw.json` 来使用其他 Qwen 模型，例如：
- `qwen/qwen-max` - 更强大的模型
- `qwen/qwen-turbo` - 更快更便宜的模型

### 2. 构建和运行

使用 **Makefile** 作为统一的构建和运行入口：

```bash
# 构建所有镜像（基础 + 扩展）
make build-all

# 或者分别构建
make build-base    # 构建基础镜像
make build         # 构建扩展镜像（会自动构建基础镜像）

# 使用 docker-compose 启动服务（推荐）
make up

# 或者直接运行容器
make run
```

### 3. 访问服务

启动服务后，您可以通过以下方式与 OpenAssistor 交互：

#### 3.1 命令行交互（推荐用于测试）
```bash
# 查看容器日志（实时输出）
make logs

# 进入容器内部（如果需要调试）
docker exec -it openassistor /bin/sh
```

#### 3.2 Web Gateway 访问
如果启用了 OpenClaw 的 gateway 功能（在 `.env` 中设置了 `OPENCLAW_GATEWAY_TOKEN`），可以通过 HTTP API 访问：

```bash
# 发送消息到助手
curl -X POST http://localhost:8080/chat \
  -H "Authorization: Bearer your-gateway-token" \
  -H "Content-Type: application/json" \
  -d '{"message": "今天的计划是什么？"}'
```

#### 3.3 IM 集成
如果配置了 Telegram 或 Discord 机器人令牌，助手会自动连接到相应的消息平台。

### 5. 数据持久化

项目已配置自动数据持久化：

- **数据目录**: 项目根目录下的 `./data` 目录会自动创建并挂载到容器
- **持久化内容**: 包括每日工作日志、周报、日历事件等所有状态数据
- **备份建议**: 定期备份 `./data` 目录以防止意外丢失

> **注意**: 第一次运行 `make up` 时，`./data` 目录会自动创建。所有重要的状态数据都会保存在这个目录中，即使容器被删除或重建，数据也不会丢失。

### 6. 目录结构说明

- `docker/Dockerfile.base`: 基础镜像定义（OpenClaw + 依赖）
- `docker/Dockerfile`: 扩展镜像定义（插件 + 配置）
- `docker/docker-compose.yml`: Docker Compose 配置文件（多服务）
- `Makefile`: 统一的构建和运行入口
- `data/`: 数据持久化目录（运行后自动生成）

### 7. Makefile 命令参考

- `make help` - 显示所有可用命令
- `make env` - 创建 .env 文件模板
- `make build-base` - 构建基础 Docker 镜像
- `make build` - 构建扩展 Docker 镜像
- `make build-all` - 构建所有镜像
- `make run` - 运行容器（交互模式）
- `make up` - 使用 docker-compose 启动服务
- `make down` - 停止 docker-compose 服务
- `make logs` - 查看容器日志
- `make clean` - 清理构建产物
