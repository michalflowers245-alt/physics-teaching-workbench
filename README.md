# 张老师物理教学工作台

本机版工作台，用于课前测、课次归档、试卷诊断、学生题单与课后制作。GitHub 上的源码从空数据库启动。真实课堂、学生资料和题库由使用者在本机管理。

## 启动

在仓库目录执行，构建和测试已验证 Node.js 25.9.0。

```bash
npm ci
npm run build
npm start
```

打开 [本机工作台](http://127.0.0.1:4173)。如果端口已占用，可用 `PORT=4174 npm start`，然后打开 4174 端口。数据默认写入本机 `data/`，可通过 `PANEL_DATA_DIR` 指定另一个目录。

## 按功能配置

| 功能 | 本机准备 |
| --- | --- |
| 课前测、时序归档、命题分类、逐题诊断与题单 | 录入合成样例或自行导入有权使用的资料。原题回查、地区趋势和逐生诊断需要本机题库与核验记录。 |
| PDF、DOCX 和课后图文导出 | 用 Python 3.12 建立下方环境。中文 PDF 字体可通过 `EXAM_EXPORT_FONT` 指定。 |
| macOS 图片 OCR | 安装命令行开发工具，执行 `swiftc native/ocr.swift -o native/panel-ocr`。 |
| 录课剪辑与语音转写 | 在 Apple Silicon Mac 安装 FFmpeg、Whisper CLI，以及用于转写的本地 Whisper 模型。用 `PANEL_WHISPER_MODEL` 指定模型文件。ChatCut 路径需要已安装的桌面端。 |
| DeepSeek 课堂总结 | 在本机工作台的 AI 配置中连接自己的 API。只使用有权提交并已去除私人信息的材料。 |

```bash
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm test
```

生产环境的部署资料、原始试卷及教材、实际反馈成品和模型凭据留在原机。新实例中的课程主题可在页面输入。有自备课程安排时，可用 `PANEL_CURRICULUM_FILE` 指定 JSON，格式示例为 `{"2099":{"秋季":{"九年级":["示例主题"]}}}`。已有题库索引如需读取本地原文件，分别用 `EXAM_LIBRARY_SOURCE_DIR` 和 `EXAM_LIBRARY_ARCHIVE_DIR` 指定目录。未配置时，原件访问保持关闭。
