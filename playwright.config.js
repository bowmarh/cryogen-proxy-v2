'use strict';

const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  timeout: 30000,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    headless: true,
    // The app registers a service worker. Requests a service worker handles bypass page.route(), so a test that mocks an API
    // response only worked when the worker had not yet taken control of the page: a race. Blocking it makes the mocks reliable.
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'node test/e2e/server.js',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
