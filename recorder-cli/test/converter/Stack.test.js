import { Stack } from '../../src/converter/Stack.js'

describe('Stack', () => {
  it('starts empty', () => {
    const stack = new Stack()
    expect(stack.isEmpty()).toBe(true)
    expect(stack.size()).toBe(0)
    expect(stack.peek()).toBeUndefined()
  })

  it('pushes and peeks without removing', () => {
    const stack = new Stack()
    stack.push('a')
    expect(stack.peek()).toBe('a')
    expect(stack.size()).toBe(1)
  })

  it('pops in LIFO order', () => {
    const stack = new Stack()
    stack.push('a')
    stack.push('b')
    expect(stack.pop()).toBe('b')
    expect(stack.pop()).toBe('a')
    expect(stack.isEmpty()).toBe(true)
  })

  it('removes a specific item without disturbing later pages', () => {
    const stack = new Stack()
    stack.push('page')
    stack.push('tab1')
    stack.push('tab2')

    stack.remove('tab1')

    expect(stack.items).toEqual(['page', 'tab2'])
    expect(stack.peek()).toBe('tab2')
  })

  it('clears all items', () => {
    const stack = new Stack()
    stack.push('a')
    stack.push('b')
    stack.clear()
    expect(stack.isEmpty()).toBe(true)
    expect(stack.size()).toBe(0)
  })
})
