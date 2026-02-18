export const GO_BACK = Symbol('GO_BACK');
export type StepResult<T> = T | typeof GO_BACK;
