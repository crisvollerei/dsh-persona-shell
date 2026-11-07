# 内置人格头像

五位内置人格均使用本地 WebP。设置、聊天室和房间组合头像显示同一张图，不依赖外部图床。

| 文件 | 人格 | 提供的参考图 |
| :--- | :--- | :--- |
| `dafeiyu.webp` | 大肥鱼（默认） | `zipzippipe-pixiv-148186519-p00.jpg` |
| `dafeilong.webp` | 大肥龙 | `zipzippipe-pixiv-148186519-p03.jpg` |
| `claude.webp` | Claude小姐 | `zipzippipe-pixiv-148186519-p02.jpg` |
| `jingjing.webp` | 小肥鱼（实验性） | `zipzippipe-BV1tE9XBbErS-05s.png` |
| `gemini.webp` | Gemini（猫猫） | ZipZipPipe [原立绘，第 5 张](https://www.pixiv.net/artworks/148186519) · `zipzippipe-pixiv-148186519-p04.jpg` |

前四张为根据所提供参考图制作的 512 × 512 头像。Gemini 直接使用用户指定的原立绘，随插件提供等比缩小的 WebP；界面在显示时取头肩区域，保留猫耳、星形发饰及原画表情，不重绘角色。上述处理均不修改用户的原始文件。

内置头像随内置人格保留，个性化修改另存为新人格。自定义头像在设置页预览取景后保存为 256 × 256 PNG；无头像的人格在预设列表保持文字卡片，在消息区使用字符头像。图片与语气卡分开保存，不进入任何模型提示词。

此目录的美术资源不因项目代码使用 MIT 而自动获得同样的再授权；角色与参考作品的相关权利归各自权利人。
