/**
 * Random utility for generated Playwright scripts.
 */

export function randomString(minLength = 8, maxLength = minLength) {
  const length = randomInt(minLength, maxLength)
  let result = ''
  while (result.length < length) {
    result += Math.random().toString(36).substring(2)
  }
  return result.substring(0, length)
}

export function randomInt(min = 0, max = 100) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

export function randomBoolean() {
  return Math.random() < 0.5
}

export function randomNumber(min = 0, max = 100, decimal = false) {
  if (decimal) {
    return +(Math.random() * (max - min) + min).toFixed(2)
  }
  return randomInt(min, max)
}

export function randomEmail(domain = 'example.com') {
  const user = randomString(6, 12).toLowerCase()
  return `${user}@${domain}`
}

export function randomPhoneNumber(country = 'US') {
  const areaCodes = { US: '1', GB: '44', AU: '61', IN: '91', DE: '49', FR: '33' }
  const code = areaCodes[country] || '1'
  const num = Array.from({ length: 10 }, () => randomInt(0, 9)).join('')
  return `+${code}${num}`
}

export function randomCurrency(country = 'US', min = 1, max = 1000, decimal = true) {
  const value = randomNumber(min, max, decimal)
  return String(value)
}

export function randomDate(format = 'MM/DD/YYYY', range = []) {
  const start = range[0] ? new Date(range[0]) : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
  const end = range[1] ? new Date(range[1]) : new Date()
  const date = new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()))

  const pad = (n) => String(n).padStart(2, '0')
  return format
    .replace('YYYY', date.getFullYear())
    .replace('MM', pad(date.getMonth() + 1))
    .replace('DD', pad(date.getDate()))
}

export function randomParagraph(minLength = 50, maxLength = 200) {
  const words = [
    'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing',
    'elit', 'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore',
    'et', 'dolore', 'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam',
  ]
  const targetLength = randomInt(minLength, maxLength)
  let result = ''
  while (result.length < targetLength) {
    result += words[randomInt(0, words.length - 1)] + ' '
  }
  return result.trim().substring(0, targetLength)
}

export function randomURL(domain = 'example.com') {
  const path = randomString(5, 10).toLowerCase()
  return `https://${domain}/${path}`
}

export async function getRandomSelector(page, selector, index) {
  const elements = await page.locator(selector).all()
  if (elements.length === 0) return null
  if (index !== null && index !== undefined) {
    return elements[Math.min(index, elements.length - 1)]
  }
  return elements[randomInt(0, elements.length - 1)]
}

export default {
  randomString, randomInt, randomBoolean, randomNumber,
  randomEmail, randomPhoneNumber, randomCurrency, randomDate,
  randomParagraph, randomURL, getRandomSelector,
}
