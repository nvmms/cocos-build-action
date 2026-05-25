# cocos-build-action

用于在 GitHub Actions 中自动构建 Cocos Creator iOS 项目，并导出 IPA 文件。

支持：

- 自动下载并缓存 Cocos Creator
- 自动执行 Cocos 构建
- 自动导入 iOS 签名证书
- 自动安装 Provisioning Profile
- 自动执行 Xcode Archive
- 自动导出 IPA
- 自动缓存：
  - Cocos Creator
  - npm cache
  - Cocos build cache
  - Xcode DerivedData

---

# Features

## Cocos Creator Cache

自动缓存 Cocos Creator 编辑器，避免每次重新下载。

## npm Cache

自动缓存 `~/.npm`。

## Cocos Build Cache

自动缓存：

- library
- temp
- build

减少二次构建时间。

## Xcode Cache

自动缓存：

- DerivedData
- ModuleCache.noindex

加速 Xcode 编译。

## iOS Signing

自动：

- 导入 p12 证书
- 创建 keychain
- 安装 mobileprovision
- Xcode 签名

---

# Inputs

| Name | Required | Description |
|---|---|---|
| `platform` | true | 构建平台，目前仅支持 `ios` |
| `cocos-url` | true | Cocos Creator zip 下载地址 |
| `ios-cert-p12` | true | Base64 编码后的 p12 证书 |
| `ios-cert-password` | true | p12 密码 |
| `ios-profile` | true | Base64 编码后的 mobileprovision |
| `ios-profile-uuid` | true | mobileprovision UUID |
| `ios-team-id` | true | Apple Team ID |
| `bundle-id` | true | App Bundle Identifier |
| `profile-name` | true | Provisioning Profile Name |
| `xcode-project` | true | xcodeproj 路径 |
| `xcode-scheme` | true | Xcode Scheme 名称 |

---

# Outputs

| Name | Description |
|---|---|
| `ipa-path` | 导出的 IPA 目录 |

---

# Example Workflow

```yaml
name: ios-build

on:
  workflow_dispatch:

jobs:
  build-ios:
    runs-on: macos-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Build IPA
        uses: nvmms/cocos-build-action
        with:
          platform: ios

          cocos-url: https://download.cocos.com/CocosCreator-v3.8.2-mac.zip

          ios-cert-p12: ${{ secrets.IOS_CERT_P12 }}
          ios-cert-password: ${{ secrets.IOS_CERT_PASSWORD }}

          ios-profile: ${{ secrets.IOS_PROFILE }}
          ios-profile-uuid: ${{ secrets.IOS_PROFILE_UUID }}

          ios-team-id: ABCDE12345

          bundle-id: com.example.game

          profile-name: game-appstore

          xcode-project: build/ios/proj/game.xcodeproj

          xcode-scheme: game-mobile

      - name: Upload IPA
        uses: actions/upload-artifact@v4
        with:
          name: ipa
          path: build/ipa
```

---

# Secrets Preparation

## p12 Certificate

导出：

```bash
Keychain Access
→ My Certificates
→ Export .p12
```

然后：

```bash
base64 -i cert.p12 | pbcopy
```

保存到：

```txt
IOS_CERT_P12
```

---

## mobileprovision

```bash
base64 -i profile.mobileprovision | pbcopy
```

保存到：

```txt
IOS_PROFILE
```

---

# Get mobileprovision UUID

```bash
security cms -D -i profile.mobileprovision
```

查找：

```xml
<key>UUID</key>
<string>xxxxxxxx</string>
```

保存：

```txt
IOS_PROFILE_UUID
```

---

# Cache Strategy

## Cocos Creator Cache

缓存 key：

```txt
cocos-{sha256(cocos-url)}
```

---

## npm Cache

缓存：

```txt
~/.npm
```

缓存 key：

```txt
npm-{package-lock hash}
```

---

## Cocos Build Cache

缓存：

- library
- temp
- build

缓存 key 基于：

- package-lock.json
- assets
- buildConfig_ios.json

自动计算 hash。

---

## Xcode Cache

缓存：

```txt
~/Library/Developer/Xcode/DerivedData
```

---

# Requirements

## GitHub Runner

必须：

```txt
macos-latest
```

因为：

- xcodebuild
- security
- codesign

仅 macOS 支持。

---

## Cocos Creator

需要：

- zip 格式下载链接
- macOS 版本

例如：

```txt
https://download.cocos.com/CocosCreator-v3.8.2-mac.zip
```

---

# Notes

## Build Config

默认读取：

```txt
./build-config/buildConfig_ios.json
```

请确保存在。

---

## Xcode Project

Cocos 构建完成后：

```txt
build/ios/proj
```

中必须存在：

```txt
.xcodeproj
```

---

## Code Signing

当前使用：

```txt
CODE_SIGN_STYLE=Manual
```

请确保：

- Bundle ID 正确
- Provisioning Profile 匹配
- Team ID 正确

---

# Example Directory Structure

```txt
project/
├── assets/
├── build-config/
│   └── buildConfig_ios.json
├── package.json
├── package-lock.json
└── .github/
    └── workflows/
        └── ios.yml
```

---

# License

MIT