import 'whatwg-fetch';
// import { stringify as formatQueryString } from 'qs';
import { camelCase, snakeCase } from 'change-case';
import { Component, Children } from 'react';
import PropTypes from 'prop-types';
import { createAction } from 'redux-actions';

class DAOError extends Error {
}

function objectIdFromResponse(response) {
  try {
    const id = response.id;
    if (id != null) {
      return id;
    }
  } catch (err) {
    // ignore
  }
  return null;
}

function getSessionId(state) {
  try {
    const sessionId = state.auth.data.sessionId;
    if (sessionId != null) {
      return sessionId;
    }
  } catch (err) {
    // ignore
  }
  return null;
}

function serialize(data) {
  if (data instanceof Array) {
    return data.map(serialize);
  } else if (data instanceof Object) {
    return Object.keys(data).reduce(
      (result, key) => {
        const newKey = snakeCase(key);
        result[newKey] = serialize(data[key]);
        return result;
      }, {}
    );
  }
  return data;
}

function serializeRequestBody(body) {
  return body !== undefined ? JSON.stringify(serialize(body)) : undefined;
}

function deserialize(data) {
  if (data instanceof Array) {
    return data.map(deserialize);
  } else if (data instanceof Object) {
    return Object.keys(data).reduce(
      (result, key) => {
        const newKey = camelCase(key);
        result[newKey] = deserialize(data[key]);
        return result;
      },
      {}
    );
  }
  return data;
}

function deserializeResponseError(originalError) {
  const error = new DAOError('DAO error has occurred');
  error.originalError = originalError;
  throw error;
}

function deserializeResponse(response) {
  if (response.status >= 400) {
    const daoError = new DAOError('Invalid status');
    daoError.httpStatus = response.status;
    return Promise.reject(daoError);
  }
  let responseJson = response.json();
  if (!(responseJson.then instanceof Function)) {
    responseJson = Promise.resolve(responseJson);
  }
  return responseJson.then(deserialize, deserializeResponseError);
}

function callApi(url, options, state) {
  const { method, headers = {}, body = null } = options;
  const sessionId = getSessionId(state);
  if (sessionId) {
    headers['X-Session-Id'] = sessionId;
  }
  try {
    return fetch(url, {
      method,
      headers,
      body: serializeRequestBody(body)
    }).then(
      deserializeResponse,
      deserializeResponseError
    );
  } catch (err) {
    return Promise.reject(err);
  }
}

const INITIAL_ITEM_STATE = {
  isFetching: false,
  didInvalidate: false,
  lastFetched: null,
  lastError: null,
  data: null
};

const INITIAL_ITEM_BY_ID_STATE = {};

function updateDetailsItem(state, objectId, newAttr) {
  const result = Object.assign({}, state);
  let itemState = result[objectId];
  if (itemState == null) {
    itemState = Object.assign({}, INITIAL_ITEM_STATE);
  }
  result[objectId] = Object.assign(itemState, newAttr);
  return result;
}

//
// reducer-y tworzyc jako 2poziomowe slowniki, { key: { actionType: func } }
// z takiej postaci da sie stworzyc generyczny reducer
//
// rozdzielic konfiguracje na dwa etapy
//   1. typy akcji
//   2. metody DAO
//   3. akcje
//   ---
//   4. reducer-y - reducer-y potrzebuja wszystkich akcji zwiazanych z danym zasobem
//

// LIST_READ            () => Promise(attr | Error)
// LIST_READ_START      () => null
// LIST_READ_END        (response) => response
//                      (errorResponse) => errorResponse
function createListEndpoint(key, url) {
  const stateAttr = key;

  const actionName = camelCase(`read_${snakeCase(key)}_list`);
  const actionType = snakeCase(actionName).toUpperCase();

  const startActionType = snakeCase(`${actionName}Start`).toUpperCase();
  const startActionFunc = createAction(startActionType, () => null);

  const endActionType = snakeCase(`${actionName}End`).toUpperCase();
  const endActionFunc = createAction(endActionType, response => response);

  const shouldExecuteFunc = (state, cachePeriod) => {
    const stateSlice = state[stateAttr];
    if (!stateSlice) {
      return true;
    } else if (stateSlice.isFetching) {
      return false;
    } else if (stateSlice.didInvalidate) {
      return true;
    } else if (stateSlice.lastError != null) {
      return true;
    }
    // czy dane w cache-u są aktualne ?
    return (
      stateSlice.lastFetched == null ||
      (cachePeriod != null && Date.now() > cachePeriod + stateSlice.lastFetched)
    );
  };

  const getDataFromState = (state) => {
    const slice = state[stateAttr];
    if (slice && !slice.isFetching && !slice.didInvalidate && !slice.lastError) {
      return slice.data;
    }
    return null;
  };

  // eslint-disable-next-line arrow-body-style
  const actionFunc = () => {
    return (dispatch, getState) => {
      const state = getState();
      if (shouldExecuteFunc(state, null)) {
        dispatch(startActionFunc());
        return callApi(url, { method: 'GET' }, state).then((response) => {
          dispatch(endActionFunc(response));
          return Promise.resolve(response);
        }).catch((error) => {
          dispatch(endActionFunc(error));
          return Promise.reject(error);
        });
      }
      return Promise.resolve(getDataFromState(state));
    };
  };

  actionFunc.actionType = actionType;
  actionFunc.startActionType = startActionType;
  actionFunc.startAction = startActionFunc;
  actionFunc.endActionType = endActionType;
  actionFunc.endAction = endActionFunc;
  actionFunc.shouldExecute = shouldExecuteFunc;

  const reducerBehaviours = {
    // eslint-disable-next-line arrow-body-style
    [startActionType]: (state /* , action */) => {
      return Object.assign({}, state, { isFetching: false, didInvalidate: false });
    },
    [endActionType]: (state, { error, payload }) => {
      if (error) {
        return Object.assign({}, state, {
          isFetching: false,
          lastFetched: Date.now(),
          lastError: payload,
          data: null
        });
      }
      return Object.assign({}, state, {
        isFetching: false,
        lastFetched: false,
        lastError: null,
        data: payload
      });
    }
  };

  const reducerFunc = (state, action) => {
    if (action.type in reducerBehaviours) {
      return reducerBehaviours[action.type](state, action);
    }
    return state || Object.assign({}, INITIAL_ITEM_STATE);
  };

  return {
    actions: { [actionName]: actionFunc },
    reducers: { [key]: reducerFunc }
  };
}

// CREATE               (attr) => Promise({ objectId, attr } | Error)
// CREATE_START         (attr) => attr
// CREATE_END           (response) => { objectId, attr: response }
//                      (errorResponse) => errorResponse
function createCreateEndpoint(key, url) {
  const actionName = camelCase(`create_${snakeCase(key)}`);
  const actionType = snakeCase(actionName).toUpperCase();

  const startActionType = snakeCase(`${actionName}Start`).toUpperCase();
  const startActionFunc = createAction(startActionType, attr => attr);

  const endActionType = snakeCase(`${actionName}End`).toUpperCase();
  const endActionFunc = createAction(endActionType, (response) => {
    if (response instanceof Error) {
      return response;
    }
    return {
      objectId: objectIdFromResponse(response),
      attr: response
    };
  });

  const shouldExecuteFunc = (/* state, attr */) => true; // zostawiam na potrzeby dokumentacji

  // eslint-disable-next-line arrow-body-style
  const actionFunc = (attr) => {
    return (dispatch, getState) => {
      const state = getState();
      if (shouldExecuteFunc(state, attr)) {
        dispatch(startActionFunc(attr));
        return callApi(url, { method: 'POST', body: attr }, state).then((response) => {
          dispatch(endActionFunc(response));
          return Promise.resolve(response);
        }).catch((error) => {
          dispatch(endActionFunc(error));
          return Promise.reject(error);
        });
      }
      return Promise.reject('Stało się coś niedobrego');
    };
  };

  actionFunc.actionType = actionType;
  actionFunc.startActionType = startActionType;
  actionFunc.startAction = startActionFunc;
  actionFunc.endActionType = endActionType;
  actionFunc.endAction = endActionFunc;

  const reducerBehaviours = {
    // eslint-disable-next-line arrow-body-style
    [startActionType]: (state /* , action */) => {
      return state || Object.assign({}, INITIAL_ITEM_STATE);
    },
    // eslint-disable-next-line arrow-body-style
    [endActionType]: (state /* , action */) => {
      return state || Object.assign({}, INITIAL_ITEM_STATE);
    }
  };

  const reducerFunc = (state, action) => {
    if (action.type in reducerBehaviours) {
      return reducerBehaviours[action.type](state, action);
    }
    return state || Object.assign({}, INITIAL_ITEM_STATE);
  };

  return {
    actions: { [actionName]: actionFunc },
    reducers: { [key]: reducerFunc }
  };
}

// READ                 (objectId) => Promise({ objectId, attr } | Error)
// READ_START           (objectId) => objectId
// READ_END             (objectId, response) => { objectId, attr: response }
//                      (objectId, errorResponse) => errorResponse
function createReadEndpoint(key, url) {
  const actionName = camelCase(`read_${snakeCase(key)}`);
  const actionType = snakeCase(actionName).toUpperCase();

  const startActionType = snakeCase(`${actionName}Start`).toUpperCase();
  const startActionFunc = createAction(startActionType, objectId => objectId);

  const endActionType = snakeCase(`${actionName}End`).toUpperCase();
  const endActionFunc = createAction(endActionType, (objectId, response) => {
    if (response instanceof Error) {
      return response;
    }
    return { objectId, attr: response };
  });

  /*
  const shouldExecuteFunc = (state, cachePeriod) => {
    const stateSlice = state[stateAttr];
    if (!stateSlice) {
      return true;
    } else if (stateSlice.isFetching) {
      return false;
    } else if (stateSlice.didInvalidate) {
      return true;
    } else if (stateSlice.lastError != null) {
      return true;
    }
    // czy dane w cache-u są aktualne ?
    return (
      stateSlice.lastFetched == null ||
      (cachePeriod != null && Date.now() > cachePeriod + stateSlice.lastFetched)
    );
  };
  */

  /*
  const getDataFromState = (state , objectId) => {
    const slice = state[stateAttr];
    if (slice && !slice.isFetching && !slice.didInvalidate && !slice.lastError) {
      return slice.data;
    }
    return null;
  };
  */

  // eslint-disable-next-line arrow-body-style
  const actionFunc = (objectId) => {
    return (dispatch, getState) => {
      const state = getState();
      dispatch(startActionFunc(objectId));
      return callApi(`${url}/${objectId}`, { method: 'GET' }, state).then((response) => {
        dispatch(endActionFunc(objectId, response));
        return Promise.resolve({ objectId, attr: response });
      }).catch((error) => {
        dispatch(endActionFunc(error));
        return Promise.reject(error);
      });
    };
  };

  actionFunc.actionType = actionType;
  actionFunc.startActionType = startActionType;
  actionFunc.startAction = startActionFunc;
  actionFunc.endActionType = endActionType;
  actionFunc.endAction = endActionFunc;

  const reducerBehaviours = {
    [startActionType]: (/* state, action */) => {
    },
    [endActionType]: (/* state, action */) => {
    }
  };

  const reducerFunc = (state, action) => {
    if (action.type in reducerBehaviours) {
      return reducerBehaviours[action.type](state, action);
    }
    return state || Object.assign({}, INITIAL_ITEM_BY_ID_STATE);
  };

  return {
    actions: { [actionName]: actionFunc },
    reducers: { [key]: reducerFunc }
  };
}

// UPDATE               (objectId, newAttr) => Promise({ objectId, newAttr } | Error)
// UPDATE_START         (objectId, newAttr) => { objectId, newAttr }
// UPDATE_END           (objectId, response) => { objectId, newAttr: response }
//                      (objectId, errorResponse) => errorResponse
function createUpdateEndpoint(key, url) {
  const actionName = camelCase(`update_${snakeCase(key)}`);
  const actionType = snakeCase(actionName).toUpperCase();

  const startActionType = snakeCase(`${actionName}Start`).toUpperCase();
  const startActionFunc = createAction(startActionType, (objectId, newAttr) => ({ objectId, newAttr }));

  const endActionType = snakeCase(`${actionName}End`).toUpperCase();
  const endActionFunc = createAction(endActionType, (objectId, response) => {
    if (response instanceof Error) {
      return response;
    }
    return { objectId, newAttr: response };
  });

  // eslint-disable-next-line arrow-body-style
  const actionFunc = (objectId, newAttr) => {
    return (dispatch /* , getState */) => {
      // const state = getState();
      dispatch(startActionFunc(objectId, newAttr));
      return callApi(`${url}/${objectId}`, {
        method: 'PUT',
        body: serializeRequestBody(newAttr)
      }).then((response) => {
        dispatch(endActionFunc(objectId, response));
        return Promise.resolve({ objectId, newAttr: response });
      }).catch((error) => {
        dispatch(endActionFunc(error));
        return Promise.reject(error);
      });
    };
  };

  actionFunc.actionType = actionType;
  actionFunc.startActionType = startActionType;
  actionFunc.startAction = startActionFunc;
  actionFunc.endActionType = endActionType;
  actionFunc.endAction = endActionFunc;

  const reducerBehaviours = {
    [startActionType]: (/* state, action */) => {
    },
    [endActionType]: (/* state, action */) => {
    }
  };

  const reducerFunc = (state, action) => {
    if (action.type in reducerBehaviours) {
      return reducerBehaviours[action.type](state, action);
    }
    return state || Object.assign({}, INITIAL_ITEM_BY_ID_STATE);
  };

  return {
    actions: { [actionName]: actionFunc },
    reducers: { [key]: reducerFunc }
  };
}

// DELETE               (objectId) => Promise({ objectId } | Error)
// DELETE_START         (objectId) => objectId
// DELETE_END           (objectId, response) => { objectId }
//                      (objectId, errorResponse) => errorResponse
function createDeleteEndpoint(key, url) {
  const actionName = camelCase(`delete_${snakeCase(key)}`);
  const actionType = snakeCase(actionName).toUpperCase();

  const startActionType = snakeCase(`${actionName}Start`).toUpperCase();
  const startActionFunc = createAction(startActionType, objectId => objectId);

  const endActionType = snakeCase(`${actionName}End`).toUpperCase();
  const endActionFunc = createAction(endActionType, (objectId, response) => {
    if (response instanceof Error) {
      return response;
    }
    return { objectId };
  });

  // eslint-disable-next-line arrow-body-style
  const actionFunc = (objectId) => {
    return (dispatch /* , getState */) => {
      // const state = getState();
      dispatch(startActionFunc(objectId));
      return callApi(`${url}/${objectId}`).then((response) => {
        dispatch(endActionFunc(objectId, response));
        return Promise.resolve(null);
      }).catch((error) => {
        dispatch(endActionFunc(objectId, error));
        return Promise.reject(error);
      });
    };
  };

  actionFunc.actionType = actionType;
  actionFunc.startActionType = startActionType;
  actionFunc.startAction = startActionFunc;
  actionFunc.endActionType = endActionType;
  actionFunc.endAction = endActionFunc;

  const reducerBehaviours = {
    [startActionType]: (/* state, action */) => {
    },
    [endActionType]: (/* state, action */) => {
    }
  };

  const reducerFunc = (state, action) => {
    if (action.type in reducerBehaviours) {
      return reducerBehaviours[action.type](state, action);
    }
    return state || Object.assign({}, INITIAL_ITEM_BY_ID_STATE);
  };

  return {
    actions: { [actionName]: actionFunc },
    reducers: { [key]: reducerFunc }
  };
}

function merge(result, extra) {
  return Object.keys(extra).reduce((memo, key) => {
    memo[key] = Object.assign({}, memo[key], extra[key]);
    return memo;
  }, result);
}

function createApi(config /* , options */) {
  const result = Object.keys(config).reduce((memo, key) => {
    const { url, operations = [] } = config[key];
    operations.forEach((operation) => {
      switch (operation) {
        case 'list':
          memo = merge(memo, createListEndpoint(key, url));
          break;
        case 'create':
          memo = merge(memo, createCreateEndpoint(key, url));
          break;
        case 'read':
          memo = merge(memo, createReadEndpoint(key, url));
          break;
        case 'update':
          memo = merge(memo, createUpdateEndpoint(key, url));
          break;
        case 'delete':
          memo = merge(memo, createDeleteEndpoint(key, url));
          break;
        default:
          break;
      }
    });
    return memo;
  }, {});
  return result;
}

class Provider extends Component {
  constructor(props) {
    super(props);
    this.api = createApi(props.apiConfig);
  }

  getChildContext() {
    return { api: this.api };
  }

  render() {
    return Children.only(this.props.children);
  }
}

Provider.displayName = 'ApiProvider';

Provider.propTypes = {
  apiConfig: PropTypes.object.isRequired, // eslint-disable-line react/forbid-prop-types
  children: PropTypes.node.isRequired
};

Provider.childContextTypes = {
  api: PropTypes.object.isRequired
};

export {
  objectIdFromResponse,
  getSessionId,
  DAOError,
  serialize,
  serializeRequestBody,
  deserialize,
  deserializeResponse,
  deserializeResponseError,
  callApi,
  updateDetailsItem,
  createListEndpoint,
  createCreateEndpoint,
  createReadEndpoint,
  createUpdateEndpoint,
  createDeleteEndpoint,
  createApi,
  Provider
};
