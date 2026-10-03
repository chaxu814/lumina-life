# 📤 发布到 GitHub · 操作清单

> 2026-10-03 审计 + 加固后生成。**所有命令都需要你自己执行**（涉及你的账号与公开权限）。
> 我没有创建任何远端仓库，也没有推送任何东西。

---

## 当前状态

| 项 | 状态 |
|---|---|
| 本地分支 | `release/hardening-20261003`（基线 `0e9e66f`，2 个新提交） |
| `git remote -v` | **空** —— 从未配置远端 |
| 目标仓库 | `chaxu814/lumina-life` —— **尚不存在** |
| GitHub 账号 | `chaxu814`（gh CLI 已认证） |
| 密钥扫描 | ✅ `.env` 未被跟踪，tracked 文件零命中密钥正则 |
| 测试 | 2472 通过 / 1 跳过 |
| `tsc --strict` | 零错误 |
| 体积回收 | docs 调试截图 2.19MB 已移出版本控制 |

---

## 第一步：合并到 master

```bash
cd "K:\2\Lumina AI"

# 确认当前状态干净
git status

# 切回 master 并合并（保留合并记录，便于回溯）
git checkout master
git merge --no-ff release/hardening-20261003 -m "merge: 发布前加固（死代码/双实现/路由仲裁/原生ABI）"
```

---

## 第二步：建仓库（二选一）

### 方案 A：直接公开（推荐，确认无误后用）

```bash
gh repo create chaxu814/lumina-life \
  --public \
  --description "有生命的 AI 桌宠 —— 三 Agent 团队协作 · 真·Computer Use · 抗幻觉记忆 · 开源" \
  --git remote origin
```

### 方案 B：先私有自查，确认后再转公开（更保险）

```bash
gh repo create chaxu814/lumina-life --private --git remote origin
# ...自查...
gh repo edit chaxu814/lumina-life --visibility public
```

---

## 第三步：推送

```bash
git push -u origin master
git push origin release/hardening-20261003
```

---

## 第四步：建 v0.1.0 Release

```bash
# 确认构建产物存在
ls dist/*.exe

gh release create v0.1.0 \
  dist/Lumina-Life-Setup-0.1.0-win-x64.exe \
  --title "v0.1.0 · 首个公开版本" \
  --notes-file .github/RELEASE_NOTES_v0.1.0.md
```

> `.github/workflows/release.yml` 已配置自动打包（tag `v*` 触发），
> 所以你也可以直接 `git tag v0.1.0 && git push origin v0.1.0` 让 CI 打包。

---

## 第五步：发布后立刻做的事

1. **把 `macOS beta · 未经实机验证` 保持在 README 顶部** —— 不要因为想显得成熟就删掉，这是可信度的来源
2. **准备一个能立刻回答的 issue 模板** —— 已加 `onboarding.md` 和 `capability.md` 两个
3. **开 Discussions** —— 这个项目的价值一半在「怎么用」的经验交流
4. **主动找一个 macOS 贡献者** —— macOS 实机验证是我们最大的已知缺口

---

## ⚠️ 发布前最后确认清单

- [ ] 已实际启动过打包后的 `.exe`（不只是跑测试）
- [ ] 新开一个 Windows 用户账号，确认「首次运行」流程能走通
- [ ] `lumina doctor` 输出正常
- [ ] README 里没有残留的调试截图引用
- [ ] 没有把 `.env`、`userData/`、本地 token 提交进去

```bash
# 快速自检：确认没有意外提交敏感文件
git ls-files | grep -E "\.env$|userData/|\.db$" || echo "✅ 无敏感文件"
```
