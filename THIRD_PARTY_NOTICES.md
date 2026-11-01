# 第三方代码与依赖声明

本项目自有代码按 GNU GPL v3（仅限第 3 版，GPL-3.0-only）提供，全文见 [LICENSE](LICENSE)。第三方代码、依赖和模型保留原有版权与许可；本项目的 GPL 不替换第三方许可证。

## 移植来源

- 学在雷达签到及球面距离拟合代码来自 ZJU-Course-Autosign/src/core.js，原项目声明 GPL-3.0-only。lib/xuezai/rollcall.ts 中的来源说明原样保留。
- lib/core/http.ts 的 HTTP/Cookie 基础实现、lib/webvpn/client.ts 的 WebVPN 适配、scripts/doc/pdf_tool.py 等保留了此前项目的迁移或改编说明。相关原始版权和来源注释不得移除。
- 平台协议、公开客户端常量和服务端内容不因收录于本项目而由本项目重新授权。用户资料、课程文件、论文及论坛内容也不属于本项目的软件许可范围。

## npm 运行依赖

当前锁文件使用以下包；以下附带其随包发布的许可原文。后续更新依赖时须同步检查并保留对应声明。

| 包 | 版本 | 许可证 |
|---|---|---|
| decimal.js | 10.6.0 | MIT |
| parse5 | 8.0.1 | MIT |
| entities | 8.1.0 | BSD-2-Clause |
| pngjs | 7.0.0 | MIT |

### decimal.js 10.6.0

来源：https://www.npmjs.com/package/decimal.js/v/10.6.0

```text
The MIT Licence.

Copyright (c) 2025 Michael Mclaughlin

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### parse5 8.0.1

来源：https://www.npmjs.com/package/parse5/v/8.0.1

```text
Copyright (c) 2013-2019 Ivan Nikulin (ifaaan@gmail.com, https://github.com/inikulin)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### entities 8.1.0

来源：https://www.npmjs.com/package/entities/v/8.1.0

```text
Copyright (c) Felix Böhm
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### pngjs 7.0.0

来源：https://www.npmjs.com/package/pngjs/v/7.0.0

```text
pngjs original work Copyright (c) 2015 Luke Page & Original Contributors
pngjs derived work Copyright (c) 2012 Kuba Niegowski

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## 可选运行组件

文档处理、音视频转写与验证码识别由相应 setup 命令按需安装第三方 Python 包、FFmpeg、识别引擎和模型。它们不随本仓库源码提供，使用与再分发分别受上游仓库、软件包和模型卡的许可约束；应保留随包许可与来源，不把本项目 GPL 视为模型或二进制的重新授权。

分发包含这些组件的完整环境或安装包时，应同时履行各组件的版权声明、源码提供和其他适用义务。
