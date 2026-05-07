export function parameteriseStep(step, pageContext, selector) {
  let methodName = ''

  if (step?.params?.random) {
    switch (step.params.dataType) {
      case 'boolean':
        methodName = 'randomBoolean()'
        break
      case 'currency':
        methodName = `randomCurrency('${step.params.country}', ${step.params.min}, ${step.params.max}, ${step.params.decimal})`
        break
      case 'date':
        methodName = `randomDate('${step.params.dateFormat}', ['${step.params.dateRange?.[0]}', '${step.params.dateRange?.[1]}'])`
        break
      case 'email':
        methodName = `randomEmail('${step.params.emailDomain}')`
        break
      case 'number':
        methodName = `randomNumber(${step.params.min}, ${step.params.max}, ${step.params.decimal})`
        break
      case 'paragraph':
        methodName = `randomParagraph(${step.params.minLength}, ${step.params.maxLength})`
        break
      case 'phone':
        methodName = `randomPhoneNumber('${step.params.country}')`
        break
      case 'string':
        methodName = `randomString(${step.params.minLength}, ${step.params.maxLength})`
        break
      case 'url':
        methodName = `randomURL('${step.params.domain}')`
        break
    }
    return `await ${pageContext}.fill('${selector}', random.${methodName})`
  }

  return ''
}
