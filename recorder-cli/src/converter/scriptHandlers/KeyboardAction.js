export class KeyBoardAction {
  constructor(context) {
    this.context = context
  }

  handle(step) {
    return [`await ${this.context.page}.keyboard.press('${step.key}');`]
  }
}
