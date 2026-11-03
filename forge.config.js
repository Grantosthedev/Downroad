require('dotenv').config();
const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const path = require('path');
const { signRuntimeDirectory } = require('./scripts/sign-bundled-runtimes');

module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/node_modules/ffmpeg-static/**',
    },
    name: 'Downroad',
    appBundleId: 'com.grantosthedev.downroad',
    icon: path.join(__dirname, 'assets', 'icon'),
    extraResource: [
      path.join(__dirname, 'bin', 'yt-dlp_macos'),
      path.join(__dirname, 'bin', 'deno'),
      path.join(__dirname, 'bin', 'bgutil-pot'),
      path.join(__dirname, 'bin', 'yt-dlp-plugins'),
      path.join(__dirname, 'bin', 'runtime-manifest.json'),
    ],
    ignore: [
      /^\/bin($|\/)/,
      /^\/assets($|\/)/,
      /^\/build($|\/)/,
      /^\/config($|\/)/,
      /^\/scripts($|\/)/,
      /^\/out($|\/)/,
      /^\/\.git/,
      /^\/\.env$/,
      /^\/\.gitignore$/,
      /^\/README\.md$/i,
      /^\/RELEASE_NOTES\.md$/i,
      /^\/forge\.config\.js$/,
      /\.d\.ts$/,
      /\.js\.map$/,
      /\/CHANGELOG(\.md)?$/i,
    ],
    osxSign: {
      identity: process.env.APPLE_SIGNING_IDENTITY || 'Developer ID Application',
      hardenedRuntime: true,
      entitlements: path.join(__dirname, 'build', 'entitlements.plist'),
      entitlementsInherit: path.join(__dirname, 'build', 'entitlements.inherit.plist'),
      signatureFlags: ['library'],
    },
    osxNotarize: {
      tool: 'notarytool',
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_ID_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    },
    afterSign: async (context) => {
      if (context.electronPlatformName !== 'darwin') return;
      const appName = context.packager.appInfo.productFilename;
      const resourcesDir = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources');
      signRuntimeDirectory(resourcesDir);
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
        name: 'Downroad',
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
    }),
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'Grantosthedev',
          name: 'Downroad',
        },
        draft: true,
        prerelease: false,
      },
    },
  ],
};