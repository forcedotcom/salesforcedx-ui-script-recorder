export class ViewportAction {
  constructor(context) {
    this.context = context
  }

  handle(step) {
    return [`await ${this.context.page}.setViewportSize({ width: ${step.width}, height: ${step.height} });`]
  }
}
