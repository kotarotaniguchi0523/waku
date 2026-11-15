// Shared by the counter page and the server functions that change it.
let count = 0;

export const getCount = () => count;
export const incrementCount = () => ++count;
