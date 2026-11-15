// Shared by the counter page and the server functions that change it.
let count = 0;

export const getCount = () => count;
export const incrementCount = () => ++count;

// Makes the next render of the counter page fail, once.
let failNextRender = false;

export const armRenderFailure = () => {
  failNextRender = true;
};

export const takeRenderFailure = () => {
  const fail = failNextRender;
  failNextRender = false;
  return fail;
};
