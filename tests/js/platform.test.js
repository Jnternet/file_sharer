import test from 'node:test';
import assert from 'node:assert/strict';

import { browserFamily, detectPlatform, isMobileUserAgent } from '../../web/lib/platform.js';

const UAS = {
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36',
  ipadClassic:
    'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1',
  ipadDesktopMode:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  windowsDesktop:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  linuxDesktop: 'Mozilla/5.0 (X11; Linux x86_64; rv:151.0) Gecko/20100101 Firefox/151.0',
  macDesktop:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
};

test('手机 UA 识别', () => {
  assert.equal(isMobileUserAgent(UAS.iphone), true);
  assert.equal(isMobileUserAgent(UAS.android), true);
  assert.equal(isMobileUserAgent(UAS.ipadClassic), true);
});

test('iPadOS 13+ 桌面版 UA（Macintosh + 多点触控）也算手机', () => {
  assert.equal(isMobileUserAgent(UAS.ipadDesktopMode), false, '只有 Macintosh UA 时不算');
  assert.equal(isMobileUserAgent(UAS.ipadDesktopMode, { maxTouchPoints: 5 }), true);
  assert.equal(isMobileUserAgent(UAS.macDesktop, { maxTouchPoints: 0 }), false);
  assert.equal(isMobileUserAgent(UAS.macDesktop, { maxTouchPoints: 1 }), false, '单个触点不算触屏 iPad');
});

test('桌面 UA 不算手机', () => {
  for (const ua of [UAS.windowsDesktop, UAS.linuxDesktop, UAS.macDesktop]) {
    assert.equal(isMobileUserAgent(ua), false, ua);
  }
  assert.equal(isMobileUserAgent(''), false);
  assert.equal(isMobileUserAgent(undefined), false);
});

test('platform 字段兜底识别 Android', () => {
  assert.equal(isMobileUserAgent('Mozilla/5.0 (X11)', { platform: 'Android' }), true);
});

function fakeScope({ userAgent, maxTouchPoints = 0, platform = '', folderInput = false, folderApi = false } = {}) {
  return {
    navigator: { userAgent, maxTouchPoints, platform },
    document: {
      createElement: () => {
        const element = { type: '', attributes: new Set(), setAttribute: (name) => element.attributes.add(name) };
        Object.defineProperty(element, 'webkitdirectory', {
          get: () => folderInput && element.attributes.has('webkitdirectory'),
        });
        return element;
      },
    },
    ...(folderApi ? { showDirectoryPicker: () => {} } : {}),
  };
}

test('手机访问：隐藏「登记文件夹」入口', () => {
  const result = detectPlatform(fakeScope({ userAgent: UAS.iphone, folderInput: true }));
  assert.equal(result.isMobile, true);
  assert.equal(result.folderInputSupported, true, '手机浏览器本身可能支持该属性');
  assert.equal(result.shouldHideFolderButton, true, '但手机上依然不显示入口');
});

test('桌面浏览器支持目录选择：显示入口', () => {
  const chrome = detectPlatform(fakeScope({ userAgent: UAS.windowsDesktop, folderInput: true }));
  assert.equal(chrome.isMobile, false);
  assert.equal(chrome.canPickFolder, true);
  assert.equal(chrome.shouldHideFolderButton, false);

  const withApi = detectPlatform(fakeScope({ userAgent: UAS.macDesktop, folderApi: true }));
  assert.equal(withApi.folderPickerApi, true);
  assert.equal(withApi.shouldHideFolderButton, false);
});

test('桌面但完全不支持目录选择：同样隐藏（避免弹出只能选文件的对话框）', () => {
  const result = detectPlatform(fakeScope({ userAgent: UAS.linuxDesktop }));
  assert.equal(result.isMobile, false);
  assert.equal(result.canPickFolder, false);
  assert.equal(result.shouldHideFolderButton, true);
});

test('缺少 document/showDirectoryPicker 也不抛错', () => {
  const result = detectPlatform({ navigator: { userAgent: UAS.linuxDesktop } });
  assert.equal(result.folderInputSupported, false);
  assert.equal(result.folderPickerApi, false);
});

test('浏览器家族识别（用于区分 Firefox 的目录选择已知问题）', () => {
  assert.equal(browserFamily(UAS.linuxDesktop), 'firefox');
  assert.equal(browserFamily(UAS.windowsDesktop), 'chromium');
  assert.equal(browserFamily(UAS.macDesktop), 'chromium');
  assert.equal(browserFamily(UAS.iphone), 'safari');
  assert.equal(
    browserFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0'),
    'edge',
  );
  assert.equal(browserFamily(''), 'other');
});

test('detectPlatform 带上 isFirefox 标记', () => {
  assert.equal(detectPlatform(fakeScope({ userAgent: UAS.linuxDesktop })).isFirefox, true);
  assert.equal(detectPlatform(fakeScope({ userAgent: UAS.windowsDesktop })).isFirefox, false);
});

test('isLinux 标记（用于提示"选择文件对话框"的已知情况）', () => {
  assert.equal(detectPlatform(fakeScope({ userAgent: UAS.linuxDesktop })).isLinux, true);
  assert.equal(
    detectPlatform(
      fakeScope({
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      }),
    ).isLinux,
    true,
  );
  assert.equal(detectPlatform(fakeScope({ userAgent: UAS.windowsDesktop })).isLinux, false);
  assert.equal(detectPlatform(fakeScope({ userAgent: UAS.android })).isLinux, false, 'Android 不算桌面 Linux');
});
