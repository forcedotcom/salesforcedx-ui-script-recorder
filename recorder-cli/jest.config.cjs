module.exports = {
  displayName: 'recorder-cli',
  rootDir: '.',
  testEnvironment: 'node',
  transform: {
    '^.+\\.js$': ['babel-jest', { rootMode: 'upward' }],
  },
  testMatch: ['<rootDir>/test/**/*.test.js'],
}
