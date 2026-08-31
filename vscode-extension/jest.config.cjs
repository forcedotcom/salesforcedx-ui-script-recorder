module.exports = {
  displayName: 'vscode-extension',
  rootDir: '.',
  testEnvironment: 'node',
  transform: {
    '^.+\\.js$': ['babel-jest', { rootMode: 'upward' }],
  },
  testMatch: ['<rootDir>/test/**/*.test.js'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/test/mocks/vscode.js',
  },
  collectCoverageFrom: ['<rootDir>/*.js', '<rootDir>/commands/*.js'],
}
