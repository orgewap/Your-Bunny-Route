/** Gesture policy: Tab is only captured over the map in select mode; outside it remains normal browser navigation. */
export type MoveTabContext = {
  selected: boolean
  tool: string
  pointerInsideMap: boolean
  textEntry: boolean
  otherModifier: boolean
}

export function shouldCaptureMoveTab(key: string, context: MoveTabContext): boolean {
  return key === 'Tab' && context.tool === 'select' &&
    context.pointerInsideMap && !context.textEntry && !context.otherModifier
}

export function canBeginObjectMove(persistentMode: boolean, tabHeld: boolean): boolean {
  return persistentMode || tabHeld
}
