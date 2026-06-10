# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个「外派行前培训课程」自动化生产系统。目标是为中国企业外派至全球各国的员工批量生成标准化的行前培训 PPT 课件。

**核心流水线**：国家名 → 检索信息文档（.docx）→ PPT 内容文档（.docx）→ PPT 课件（.pptx）

## 工具链 Skills（6 个，按调用顺序）

| Skill | 触发词 | 输入 → 输出 |
|-------|--------|------------|
| `training-abroad-research` | "检索XX信息"、"搜XX外派培训资料" | 国家名 → `Output/检索信息结果/XX检索信息结果.docx` |
| `ppt-content-generator` | "生成XX课程内容"、"做PPT内容" | 检索文档 → `Output/PPT内容文件/XX出国培训课程文档/`（7个docx） |
| `ppt-generator` | "生成XX PPT课件"、"生成XX培训PPT" | PPT内容文档 → `Output/PPT课件/XX出国培训课件/`（7个pptx） |
| `docx` | 文档创建/编辑 | 通用 Word 文档生成 |
| `pptx` | PPT 创建/编辑 | 通用 PowerPoint 操作（html2pptx 工作流） |
| `qiuzhi-skill-creator` | "创建Skill" | 交互式 Skill 创建向导 |

## 关键技术栈

- **Node.js**（v24）：`pptxgenjs` + `docx` + `playwright` + `sharp`
- **Python 3.12**（`C:\Users\24371\AppData\Local\Programs\Python\Python312`）：volcengine-image-gen
- **PowerShell**：项目默认 Shell，Python 需手动加 PATH 运行：
  ```
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  $env:PYTHONIOENCODING = "utf-8"  # 防止 GBK 编码错误
  ```
- **Tavily MCP**：全局配置（`claude mcp add --scope user tavily`），用于网页搜索和图片搜索
- **火山引擎 Seedream 4.5**：`volcengine-image-gen` Skill，国内直连 AI 图片生成

## 项目目录结构

```
├── Basic Outline/          # 课程框架参考（只读）
│   ├── 课程基本信息及开发指南  # 课程目标、国别替换规范、通用模块列表、版本矩阵
│   ├── 章节大纲               # 6章详细大纲（每章时长·子标题·配套工具）
│   └── 第一章PPT大纲样例.docx  # PPT内容文档格式模板
├── Output/                 # 所有产出物
│   ├── 检索信息结果/        # training-abroad-research 产物
│   ├── PPT内容文件/         # ppt-content-generator 产物
│   └── PPT课件/            # ppt-generator 产物
├── workspace/              # 临时文件（图片、解包XML、生成脚本）
├── .claude/skills/         # 项目级 Claude Skills
├── .agents/skills/         # 通过 npx skills add 安装的外部 Skills
└── 检索信息提示词            # （无扩展名）检索标准、搜索关键词、输出格式示例
```

## 关键设计规则

### 内容分层（来自《课程基本信息及开发指南》）
- **通用内容**（固定）：心态建设、安全场景应对、商务沟通、合规准则、风险上报 — 所有国家版本统一
- **国别内容**（可替换）：历史·政经·宗教·签证·住房·交通·法律·风险 — 每个国家独立检索
- **企业定制内容**（留白）：合规政策、部门利益方地图 — 由具体企业补充

### PPT 课件生成规范（ppt-generator）

**首选方案**：PptxGenJS 纯矢量设计（形状·卡片·时间轴·大数字），188 KB/章，无需 playwright。

配色：深蓝 `1a2639`、蓝色 `2b5797`、橙色 `e07b39`、浅灰 `f0f2f5`、白色 `ffffff`

7 种页面模板：封面（深蓝全幅）、总览（6宫格图标卡）、数据（大数字卡）、时间轴（水平线+节点）、指标（左指标右环图）、表格（彩色表头）、小结（深蓝2×3卡片）。

**图片策略**：官方内容（国旗/肖像/建筑/货币）用 Tavily 搜索，场景配图用火山引擎生成。优先用形状代替图片。

### 全程自动原则（training-abroad-research / ppt-content-generator / ppt-generator）
- 搜索 → 整理 → 自检 → 修正 → 生成：全流程不询问用户
- 仅在搜索无果时暂停告知缺失信息

### 版本管理（ppt-content-generator / ppt-generator）
- 调整后另存为 V1 → V2 → V3
- 用户确认后删除旧版，仅保留最新版

## 常见操作

```bash
# 安装新 npm 包（项目本地）
npm install <package>

# Python 图片生成（需先设置 PATH 和 PYTHONIOENCODING）
python ".agents/skills/volcengine-image-gen/scripts/generate.py" "prompt" -r 16:9 -o "output.png"

# 搜索安装外部 Skill
npx skills find "关键词"
npx skills add <owner/repo@skill> -y

# 查看 MCP 状态
claude mcp list

# 解包 docx/pptx 分析 XML
unzip -o file.docx -d output_dir/
```
# Auto-sync test
