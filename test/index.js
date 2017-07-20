/* global describe, it, beforeEach, afterEach */
import { bindActionCreators } from 'redux';
import thunkMiddleware from 'redux-thunk';
import chai, { expect } from 'chai';
import chaiPromised from 'chai-as-promised';
import chaiReduxMockStore from 'chai-redux-mock-store';
import fetchMock from 'fetch-mock';
import configureStore from 'redux-mock-store';
import {
  objectIdFromResponse,
  getSessionId,
  DAOError,
  serialize,
  serializeRequestBody,
  deserialize,
  deserializeResponseError,
  deserializeResponse,
  callApi,
  createListEndpoint,
  createCreateEndpoint,
  createReadEndpoint,
  createUpdateEndpoint,
  createDeleteEndpoint
} from '../src/index';

chai.use(chaiPromised);
chai.use(chaiReduxMockStore);

describe('shared/api/utils', () => {
  it('objectIdFromResponse() should return response.id or null', () => {
    expect(objectIdFromResponse()).to.be.equal(null);
    expect(objectIdFromResponse(null)).to.be.equal(null);
    expect(objectIdFromResponse({ id: '2' })).to.be.equal('2');
    expect(objectIdFromResponse({})).to.be.equal(null);
  });

  it('getSessionId() should return session ID from state or null', () => {
    expect(getSessionId({})).to.be.equal(null);
    expect(getSessionId({ auth: 1 })).to.be.equal(null);
    expect(getSessionId({ auth: { data: { sessionId: '1' } } })).to.be.equal('1');
  });

  it('serialize() should transform camelCase to under_score', () => {
    expect(serialize({
      camelCase: [
        { subProp: { deepProp: 3 } }
      ]
    })).to.be.deep.equal({
        camel_case: [
          { sub_prop: { deep_prop: 3 } }
        ]
      });
  });

  it('serializeRequestBody() should return stringified JSON or undefined', () => {
    expect(serializeRequestBody(undefined)).to.be.equal(undefined);
    expect(serializeRequestBody(null)).to.be.equal('null');
    expect(serializeRequestBody({ attr: 2 })).to.be.equal('{"attr":2}');
  });

  it('deserialize() should transform under_score to camelCase', () => {
    expect(deserialize({
      under_score: [
        { sub_prop: { deep_prop: 4 } }
      ]
    })).to.be.deep.equal({
        underScore: [
          { subProp: { deepProp: 4 } }
        ]
      });
  });

  it('deserializeResponseError() should return Error subclass', () => {
    class CustomError extends Error {}
    const customError = new CustomError();
    try {
      deserializeResponseError(customError);
    } catch (err) {
      expect(err).to.be.instanceof(Error);
      expect(err).to.have.property('originalError', customError);
    }
  });

  it('deserializeResponse() should return response data if status < 400', (done) => {
    expect(deserializeResponse({
      status: 200,
      json() { return { someProp: [1] }; }
    })).to.become({ someProp: [1] });
    expect(deserializeResponse({
      status: 399,
      json() {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            resolve({ someProp: [3] });
          }, 1);
        });
      }
    })).to.become({ someProp: [3] }).notify(done);
  });

  it('deserializeResponse() should reject if status >= 400', (done) => {
    expect(deserializeResponse({
      status: 400,
      json() { return {}; }
    })).to.be.rejected.notify(done);
  });

  it('deserializeResponse() should reject if status >= 400 and json() returns a Promise', (done) => {
    deserializeResponse({
      status: 427,
      json() {
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            resolve({});
          }, 1);
        });
      }
    }).then(() => {
      try {
        expect.fail(1, 0, 'Should not resolve a promise');
        done();
      } catch (err) {
        done(err);
      }
    }, (error) => {
      try {
        expect(error).to.be.instanceof(Error);
        expect(error).to.have.property('httpStatus', 427);
        done();
      } catch (err) {
        done(err);
      }
    });
  });
});

describe('shared/api/callApi', () => {
  beforeEach(() => {
    fetchMock.get('some-url', { responseAttr: [1, 2] });
    fetchMock.post('some-url', { responseAttr: 3 });
  });

  afterEach(() => {
    fetchMock.restore();
  });

  it('should call fetch with the right HTTP method value - GET', (done) => {
    expect(callApi('some-url', { method: 'GET' })).to.eventually.become({ responseAttr: [1, 2] }).notify(done);
  });

  it('should call fetch with the right HTTP method value - POST', (done) => {
    expect(callApi('some-url', { method: 'POST' })).to.eventually.become({ responseAttr: 3 }).notify(done);
  });

  it('should reject if the HTTP method is wrong', (done) => {
    callApi('some-url', { method: 'PUT' }).then((response) => {
      try {
        expect.fail(1, 0, 'Should not resolve');
        done();
      } catch (err) {
        done(err);
      }
    }, () => {
      done();
    });
  });
});

describe('shared/api/createListEndpoint', () => {
  it('should create actions and action types', () => {
    const { actions } = createListEndpoint('entity', 'some-url');
    expect(actions).to.have.keys('readEntityList');
    expect(actions.readEntityList).to.have.property('actionType', 'READ_ENTITY_LIST');
    expect(actions.readEntityList).to.have.property('startActionType', 'READ_ENTITY_LIST_START');
    expect(actions.readEntityList).to.have.property('startAction').to.be.instanceof(Function);
    expect(actions.readEntityList).to.have.property('endActionType', 'READ_ENTITY_LIST_END');
    expect(actions.readEntityList).to.have.property('endAction').to.be.instanceof(Function);
    expect(actions.readEntityList).to.have.property('shouldExecute').to.be.instanceof(Function);
  });

  it('startAction() signature should be () => null', () => {
    const { actions: { readEntityList: { startActionType, startAction } } } = createListEndpoint('entity', 'some-url');

    const action1 = startAction();
    expect(action1).to.have.property('type', startActionType);
    expect(action1).to.have.property('payload', null);
    expect(action1).to.not.have.property('error');

    const action2 = startAction(2);
    expect(action2).to.have.property('type', startActionType);
    expect(action2).to.have.property('payload', null);
    expect(action2).to.not.have.property('error');
  });

  it('endAction() signature should be response => response', () => {
    const { actions: { readEntityList: { endActionType, endAction } } } = createListEndpoint('entity', 'some-url');

    const action1 = endAction(null);
    expect(action1).to.have.property('type', endActionType);
    expect(action1).to.have.property('payload', null);
    expect(action1).to.not.have.property('error');

    const arrayResponse = [1, 2, 3];
    const action2 = endAction(arrayResponse);
    expect(action2).to.have.property('payload', arrayResponse);
    expect(action2).to.not.have.property('error');

    const errorResponse = new DAOError('Invalid data');
    const action3 = endAction(errorResponse);
    expect(action3).to.have.property('type', endActionType);
    expect(action3).to.have.property('payload', errorResponse);
    expect(action3).to.have.property('error', true);
  });

  it('shouldExecute()', () => {
    const { actions: { readEntityList: { shouldExecute } } } = createListEndpoint('entity', 'some-url');

    // not yet fetched - true
    expect(shouldExecute({}, null)).to.be.true;

    // already being fetching - false
    expect(shouldExecute({ entity: { isFetching: true } }, null)).to.be.false;

    // fetch only if invalidated
    expect(shouldExecute({ entity: { isFetching: true, didInvalidate: false } }, null)).to.be.false;
    expect(shouldExecute({ entity: { isFetching: false, didInvalidate: true } }, null)).to.be.true;

    // fetch if there was an error before, otherwise return data from store
    expect(shouldExecute(
      { entity: { isFetching: false, didInvalidate: false, lastError: new Error() } }, null
    )).to.be.true;

    // fetch if this is the first time
    expect(shouldExecute(
      { entity: { isFetching: false, didInvalidate: false, lastError: null, lastFetched: null } }, null
    )).to.be.true;
    // fetch if the cache is infinite
    expect(shouldExecute({
      entity: {
        isFetching: false,
        didInvalidate: false,
        lastError: null,
        lastFetched: Date.now() - 1000
      }
    }, null)).to.be.false;
    // fetch if the cache has expired
    expect(shouldExecute({
      entity: {
        isFetching: false,
        didInvalidate: false,
        lastError: null,
        lastFetched: Date.now() - 1000
      }
    }, 500)).to.be.true;
    expect(shouldExecute({
      entity: {
        isFetching: false,
        didInvalidate: false,
        lastError: null,
        lastFetched: Date.now() - 1000
      }
    }, 5000)).to.be.false;
  });

  describe('action()', () => {
    const API_RESPONSE = [{ id: 1, displayName: 'Name 1' }];
    let store, readEntityList;

    beforeEach(() => {
      fetchMock.get('some-url', API_RESPONSE);
      store = configureStore([thunkMiddleware])({});
      readEntityList = bindActionCreators(
        createListEndpoint('entity', 'some-url').actions.readEntityList,
        store.dispatch
      );
    });

    afterEach(() => {
      readEntityList = null;
      store = null;
      fetchMock.restore();
    });

    it('action() should work in the success scenario', (done) => {
      readEntityList().then((response) => {
        try {
          expect(response).to.be.deep.equal(API_RESPONSE);
          expect(store).to.have.dispatchedTypes(['READ_ENTITY_LIST_START', 'READ_ENTITY_LIST_END']);
          done();
        } catch (err) {
          done(err);
        }
      }).catch((error) => {
        done(error);
      });
    });
  });
});

describe('shared/api/createCreateEndpoint', () => {
  it('should create actions and action types', () => {
    const { actions } = createCreateEndpoint('entity', 'some-url');
    expect(actions).to.have.keys('createEntity');
    expect(actions.createEntity).to.have.property('actionType', 'CREATE_ENTITY');
    expect(actions.createEntity).to.have.property('startActionType', 'CREATE_ENTITY_START');
    expect(actions.createEntity).to.have.property('startAction').to.be.instanceof(Function);
    expect(actions.createEntity).to.have.property('endActionType', 'CREATE_ENTITY_END');
    expect(actions.createEntity).to.have.property('endAction').to.be.instanceof(Function);
  });

  it('startAction() signature', () => {
    const { actions: { createEntity: { startActionType, startAction } } } = createCreateEndpoint('entity', 'some-url');

    const normalResponse = { id: 1, a: 2, b: 2 };
    const normalAction = startAction(normalResponse);
    expect(normalAction).to.have.property('type', startActionType);
    expect(normalAction).to.have.deep.property('payload', normalResponse);

    const errorResponse = new Error('Some nasty error');
    const errorAction = startAction(errorResponse);
    expect(errorAction).to.have.property('type', startActionType);
    expect(errorAction).to.have.property('payload', errorResponse);
    expect(errorAction).to.have.property('error', true);
  });

  it('endAction() signature', () => {
    const { actions: { createEntity: { endActionType, endAction } } } = createCreateEndpoint('entity', 'some-url');

    const response1 = { id: 1, attr: 2, someOtherAttr: [2, 3] };
    const action1 = endAction(response1);
    expect(action1).to.have.property('type', endActionType);
    expect(action1).to.have.property('payload').and.to.be.deep.equal({ objectId: response1.id, attr: response1 });
    expect(action1).to.not.have.property('error');

    const response2 = { attr: 3, anotherAttr: 4 };
    const action2 = endAction(response2);
    expect(action2).to.have.property('type', endActionType);
    expect(action2).to.have.property('payload').and.to.be.deep.equal({ objectId: null, attr: response2 });
    expect(action2).to.not.have.property('error');

    const response3 = new Error('Some mystic error');
    const action3 = endAction(response3);
    expect(action3).to.have.property('payload', response3);
    expect(action3).to.have.property('error', true);
  });

  it('shouldExecute()', () => {
    // TODO implement
  });

  describe('action()', () => {
    const API_RESPONSE = { id: 1, data: 'attr' };
    let store, createEntity;

    beforeEach(() => {
      fetchMock.post('some-url', API_RESPONSE).catch(404);
      store = configureStore([thunkMiddleware])({});
      createEntity = bindActionCreators(
        createCreateEndpoint('entity', 'some-url').actions.createEntity,
        store.dispatch
      );
    });

    afterEach(() => {
      createEntity = store = null;
      fetchMock.restore();
    });

    it('should work in the success scenario', (done) => {
      createEntity({ data: 'attr '}).then((response) => {
        try {
          expect(response).to.be.deep.equal(API_RESPONSE);
          expect(store).to.have.dispatchedTypes(['CREATE_ENTITY_START', 'CREATE_ENTITY_END']);
          done();
        } catch (err) {
          done(err);
        }
      }).catch(done);
    });
  });
});

describe('shared/api/createReadEndpoint', () => {
  it('should create actions and action types', () => {
    const { actions } = createReadEndpoint('entity', 'some-url');
    expect(actions).to.have.keys('readEntity');
    expect(actions.readEntity).to.have.property('actionType', 'READ_ENTITY');
    expect(actions.readEntity).to.have.property('startActionType', 'READ_ENTITY_START');
    expect(actions.readEntity).to.have.property('startAction').to.be.instanceof(Function);
    expect(actions.readEntity).to.have.property('endActionType', 'READ_ENTITY_END');
    expect(actions.readEntity).to.have.property('endAction').to.be.instanceof(Function);
  });

  it('startAction() signature', () => {
  });

  it('endAction() signature', () => {
  });

  it('shouldExecute()', () => {
  });

  it('action()', () => {
  });
});

describe('shared/api/createUpdateEndpoint', () => {
  it('should create actions and action types', () => {
    const { actions } = createUpdateEndpoint('entity', 'some-url');
    expect(actions).to.have.keys('updateEntity');
    expect(actions.updateEntity).to.have.property('actionType', 'UPDATE_ENTITY');
    expect(actions.updateEntity).to.have.property('startActionType', 'UPDATE_ENTITY_START');
    expect(actions.updateEntity).to.have.property('startAction').to.be.instanceof(Function);
    expect(actions.updateEntity).to.have.property('endActionType', 'UPDATE_ENTITY_END');
    expect(actions.updateEntity).to.have.property('endAction').to.be.instanceof(Function);
  });

  it('startAction() signature', () => {
    const { actions: { updateEntity: { startActionType, startAction } } } = createUpdateEndpoint('entity', 'some-url');
    expect(startAction(1, { prop: 2 })).to.have.deep.property('payload', { objectId: 1, newAttr: { prop: 2 } });
  });

  it('endAction() signature', () => {
    const { actions: { updateEntity: { endActionType, endAction } } } = createUpdateEndpoint('entity', 'some-url');

    const response = { prop: 2 };
    expect(endAction(1, response)).to.have.deep.property('payload', { objectId: 1, newAttr: response });
    expect(endAction(1, response)).to.not.have.property('error');

    const errorResponse = new Error('B³¹d');
    expect(endAction(1, errorResponse)).to.have.property('payload', errorResponse);
    expect(endAction(1, errorResponse)).to.have.property('error', true);
  });

  it('shouldExecute()', () => {
  });

  describe('action()', () => {
    const API_RESPONSE = { prop: 245 };
    let store, updateEntity;

    beforeEach(() => {
      fetchMock.put('some-url/1', API_RESPONSE);
      store = configureStore([thunkMiddleware])({});
      updateEntity = bindActionCreators(
        createUpdateEndpoint('entity', 'some-url').actions.updateEntity,
        store.dispatch
      );
    });

    afterEach(() => {
      updateEntity = null;
      store = null;
      fetchMock.restore();
    });

    it('action() should work in default success scenario', (done) => {
      updateEntity(1, { prop: 246 }).then((response) => {
        try {
          expect(response).to.be.deep.equal({ objectId: 1, newAttr: API_RESPONSE });
          expect(store).to.have.dispatchedTypes(['UPDATE_ENTITY_START', 'UPDATE_ENTITY_END']);
          done();
        } catch (err) {
          done(err);
        }
      }).catch(done);
    });
  });
});

describe('shared/api/createDeleteEndpoint', () => {
  it('should create actions and action types', () => {
    const { actions } = createDeleteEndpoint('entity', 'some-url');
    expect(actions).to.have.keys('deleteEntity');
    expect(actions.deleteEntity).to.have.property('actionType', 'DELETE_ENTITY');
    expect(actions.deleteEntity).to.have.property('startActionType', 'DELETE_ENTITY_START');
    expect(actions.deleteEntity).to.have.property('startAction').to.be.instanceof(Function);
    expect(actions.deleteEntity).to.have.property('endActionType', 'DELETE_ENTITY_END');
    expect(actions.deleteEntity).to.have.property('endAction').to.be.instanceof(Function);
  });

  it('startAction() signature', () => {
    const { actions: { deleteEntity: {  startActionType, startAction } } } = createDeleteEndpoint('entity', 'some-url');

    const response1 = {};
    const action1 = startAction(response1);
    expect(action1).to.have.property('type', startActionType);
    expect(action1).to.have.property('payload').and.to.be.deep.equal(response1);
    expect(action1).to.not.have.property('error');

    const response2 = new Error('Network');
    const action2 = startAction(response2);
    expect(action2).to.have.property('type', startActionType);
    expect(action2).to.have.property('payload', response2);
    expect(action2).to.have.property('error', true);
  });

  it('endAction() signature', () => {
    const { actions: { deleteEntity: {  endActionType, endAction } } } = createDeleteEndpoint('entity', 'some-url');

    const response1 = {};
    const action1 = endAction(123, response1);
    expect(action1).to.have.property('type', endActionType);
    expect(action1).to.have.property('payload').and.to.be.deep.equal({ objectId: 123 });
    expect(action1).to.not.have.property('error');

    const response2 = new Error('Network');
    const action2 = endAction(123, response2);
    expect(action2).to.have.property('type', endActionType);
    expect(action2).to.have.property('payload', response2);
    expect(action2).to.have.property('error', true);
  });

  it('shouldExecute()', () => {
  });

  it('action()', () => {
    const API_RESPONSE = {};
    let store, deleteEntity;

    beforeEach(() => {
      fetchMock.delete('some-url/1', API_RESPONSE);
      store = configureStore([thunkMiddleware])({});
      deleteEntity = bindActionCreators(
        createDeleteEndpoint('entity', 'some-url').actions.deleteEntity,
        store.dispatch
      );
    });

    afterEach(() => {
      deleteEntity = null;
      store = null;
      fetchMock.restore();
    });

    it('action() should work in default success scenario', (done) => {
      deleteEntity(1).then((response) => {
        try {
          expect(response).to.be.deep.equal({ objectId: 1 });
          expect(store).to.have.dispatchedTypes(['DELETE_ENTITY_START', 'DELETE_ENTITY_END']);
          done();
        } catch (err) {
          done(err);
        }
      }).catch(done);
    });
  });
});
