module.exports = {
  projects: ['<rootDir>/recorder-cli', '<rootDir>/vscode-extension'],
  collectCoverage: true,
  collectCoverageFrom: [
    'recorder-cli/bin/**/*.js',
    'recorder-cli/src/**/*.js',
    'recorder-cli/scripts/**/*.js',
    '!recorder-cli/src/injected/vendor/**',
    'vscode-extension/**/*.js',
    '!vscode-extension/test/**',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  coverageThreshold: {
    global: {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
}
