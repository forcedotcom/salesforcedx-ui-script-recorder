export class NavigateAction {
  constructor(context) {
    this.context = context
  }

  handle(step) {
    return [`await ${this.context.page}.goto('${step.url}');`]
  }
}
