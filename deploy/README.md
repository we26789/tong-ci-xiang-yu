# 联机服务部署

联机服务与 GitHub Pages 分别发布。Pages 只运行同屏玩法，完整联机站点由 Node 提供页面和 `/api/`，两者必须保持同源，浏览器席位保存在 HttpOnly Cookie 中。

## 当前状态

公网联机使用 `https://120.77.201.3/tongci/`，原服务器的 HTTP 和 HTTPS 首页仍为协作平台。游戏通过一个只匹配 `/tongci/` 的 Nginx location 转发到回环 Node 服务，不能重新用原项目根地址承载游戏。独立端口 8443 的入口曾在公网连接超时，当前使用已开放的 HTTPS 443 端口下的专用路径。

原站 HTTPS 仍使用已签发的 IP 证书，续签定时器继续运行；证书及续签工具位于 `/opt/tong-ci-xiang-yu/ops/`，不能当作停用游戏的临时文件删除。

## 独立地址部署参考

- Node.js 24 独立运行时；不替换服务器其他项目的 Node。
- 独立用户 `tongci`，应用目录 `/opt/tong-ci-xiang-yu/`。
- `releases/<commit>/` 存放每次发布，`current` 符号链接指向启用版本。
- systemd 单实例服务 `tong-ci-xiang-yu.service`，仅监听 `127.0.0.1:41731`。
- 当前使用 `nginx-tongci-path.conf`，放在原站已有 include 的扩展目录，保留原站主配置。该配置只处理 `/tongci` 和 `/tongci/`，HTTP 游戏路径跳转 HTTPS，原站 `/`、`/assets/`、`/api/` 保持原路由。
- Node 通过 `PUBLIC_URL` 取得路由前缀，房间 Cookie 限定 `Path=/tongci/`；子目录服务不设置影响整个主机的 HSTS。
- `backups/` 在服务器保留首次发布前的 Nginx 配置。

服务环境文件 `/etc/tong-ci-xiang-yu.env`：

```dotenv
HOST=127.0.0.1
PORT=41731
TRUST_PROXY=loopback
PUBLIC_URL=https://120.77.201.3/tongci/
```

可以参考本目录的 systemd 和 Nginx 配置。不要把证书私钥、SSH 私钥或实际环境文件提交到仓库。新建虚拟主机前检查冲突，执行 `nginx -t` 成功后再 reload。

`TRUST_PROXY=loopback` 只用于仅监听回环地址、由本机 Nginx 转发的部署：此时读取本机代理覆盖写入的 `X-Real-IP`，按实际玩家地址限速。直接对外监听的本地服务保持默认值，不信任客户端转发头。

## 验收与维护

```sh
systemctl status tong-ci-xiang-yu
curl --fail https://120.77.201.3/tongci/api/info
journalctl -u tong-ci-xiang-yu --since '30 minutes ago'
```

使用两个隔离的浏览器会话，实际创建、分享链接加入、双方锁词、同步揭晓并退出。确认响应中的分享地址使用 HTTPS 公网地址。停止或重启服务会清空内存房间，旧邀请码失效。

IP 地址证书使用 Let's Encrypt `shortlived` 配置，需要 Certbot 5.4 及以上版本。证书配置放在 `/opt/tong-ci-xiang-yu/ops/letsencrypt/`，独立 systemd 定时任务每六小时检查续签；成功续签后执行 `nginx -t` 和 reload。证书由服务器生成和保存。若改用域名，须同时更新证书、Nginx 主机名、`PUBLIC_URL` 和 GitHub 仓库变量 `ONLINE_GAME_URL`。

## 更新与回退

每次先运行 `npm test`。用 `git archive <commit>` 打包已提交的源码，将归档复制到新的 `releases/<commit>/`，在服务器使用独立 Node 运行测试。测试通过后切换 `current` 并重启本项目服务，执行公网检查。

需要回退时，将 `current` 改回上一版本目录，再重启本项目服务。保留上一个版本目录和所有现有项目文件。GitHub Pages 可通过回退提交并重新运行工作流恢复。源码推送只会自动更新 Pages，服务器版本需要单独发布。
