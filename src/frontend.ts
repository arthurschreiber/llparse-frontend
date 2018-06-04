import * as assert from 'assert';
import * as debugAPI from 'debug';
import { SpanAllocator } from 'llparse-builder';

import { Implementation } from './implementation';
import * as frontend from './namespace/frontend';
import * as source from './namespace/source';
import { SpanField } from './span-field';
import { Trie, TrieEmpty, TrieNode, TrieSequence, TrieSingle } from './trie';
import { Identifier, IUniqueName } from './utils';

const debug = debugAPI('llparse:translator');

export { code, node, transform } from './namespace/frontend';

export {
  Implementation,
  IUniqueName,
  SpanField,
};

export interface IImplementation
  <N extends Implementation<frontend.node.Node<N>>> {
  readonly code: frontend.code.ICodeImplementation;
  readonly node: frontend.node.INodeImplementation<N>;
  readonly transform: frontend.transform.ITransformImplementation;
}

export interface IFrontendOptions {
  readonly maxTableElemWidth: number;
  readonly minTableSize: number;
}

interface ITableLookupTarget {
  readonly keys: number[];
  readonly noAdvance: boolean;
  readonly trie: TrieEmpty;
}

export class Frontend<N extends Implementation<frontend.node.Node<N>>> {
  private readonly id: Identifier = new Identifier(this.prefix + '__n_');
  private readonly codeId: Identifier = new Identifier(this.prefix + '__c_');
  private readonly map: Map<source.node.Node, N> = new Map();
  private readonly spanMap: Map<source.Span, SpanField> = new Map();
  private readonly codeCache: Map<string, frontend.code.Code> = new Map();

  constructor(private readonly prefix: string,
              private readonly implementation: IImplementation<N>,
              private readonly options: IFrontendOptions) {
    assert(0 < options.maxTableElemWidth,
      'Invalid `options.maxTableElemWidth`, must be positive');
  }

  public build(root: source.node.Node): N {
    const spanAllocator = new SpanAllocator();
    const sourceSpans = spanAllocator.allocate(root);

    const spans = sourceSpans.concurrency.map((concurrent, index) => {
      const span = new SpanField(index, concurrent.map((sourceSpan) => {
        return this.translateCode(sourceSpan.callback) as frontend.code.Span;
      }));

      for (const sourceSpan of concurrent) {
        this.spanMap.set(sourceSpan, span);
      }

      return span;
    });

    return this.translate(root);
  }

  private translate(node: source.node.Node): N {
    if (this.map.has(node)) {
      return this.map.get(node)!;
    }

    let result: N | undefined;
    let list: ReadonlyArray<N> | undefined;

    const id = (): IUniqueName => this.id.id(node.name);
    const nodeImpl = this.implementation.node;

    // Instantiate target class
    if (node instanceof source.node.Error) {
      result = new nodeImpl.Error(
        new frontend.node.Error(id(), node.code, node.reason));
    } else if (node instanceof source.node.Pause) {
      result = new nodeImpl.Pause(
        new frontend.node.Pause(id(), node.code, node.reason));
    } else if (node instanceof source.node.Consume) {
      result = new nodeImpl.Consume(
        new frontend.node.Consume(id(), node.field));
    } else if (node instanceof source.node.SpanStart) {
      result = new nodeImpl.SpanStart(
        new frontend.node.SpanStart(id(), this.spanMap.get(node.span)!,
          this.translateCode(node.span.callback) as frontend.code.Span));
    } else if (node instanceof source.node.SpanEnd) {
      result = new nodeImpl.SpanEnd(
        new frontend.node.SpanEnd(id(), this.spanMap.get(node.span)!,
          this.translateCode(node.span.callback) as frontend.code.Span));
    } else if (node instanceof source.node.Invoke) {
      result = new nodeImpl.Invoke(
        new frontend.node.Invoke(id(), this.translateCode(node.code)));
    } else if (node instanceof source.node.Match) {
      list = this.translateMatch(node);
    } else {
      throw new Error(`Unknown node type for "${node.name}"`);
    }

    // Initialize result
    const otherwise = node.getOtherwiseEdge();

    if (list !== undefined) {
      assert(node instanceof source.node.Match);
      const match = node as source.node.Match;

      // TODO(indutny): move this to llparse-builder?
      assert.notStrictEqual(otherwise, undefined,
        `Node "${node.name}" has no \`.otherwise()\``);

      // Assign otherwise to every node of Trie
      if (otherwise !== undefined) {
        for (const child of list) {
          child.ref.setOtherwise(this.translate(otherwise.node),
            otherwise.noAdvance);
        }
      }

      // Assign transform to every node of Trie
      const transform = this.translateTransform(match.getTransform());
      for (const child of list) {
        assert(child.ref instanceof frontend.node.Match);
        (child.ref as frontend.node.Match<N>).setTransform(transform);
      }

      assert(list.length >= 1);
      return list[0];
    } else if (result !== undefined) {
      // Break loops
      this.map.set(node, result);

      if (otherwise !== undefined) {
        result.ref.setOtherwise(this.translate(otherwise.node),
          otherwise.noAdvance);
      } else {
        // TODO(indutny): move this to llparse-builder?
        assert(node instanceof source.node.Error,
          `Node "${node.name}" has no \`.otherwise()\``);
      }

      if (result instanceof this.implementation.node.Invoke) {
        for (const edge of node) {
          assert(result.ref instanceof frontend.node.Invoke);

          const invoke = result.ref as frontend.node.Invoke<N>;
          invoke.addEdge(edge.key as number, this.translate(edge.node));
        }
      } else {
        assert.strictEqual(Array.from(node).length, 0);
      }

      return result;
    } else {
      throw new Error('Unreachable');
    }
  }

  private translateMatch(node: source.node.Match): ReadonlyArray<N> {
    const trie = new Trie(node.name);

    const otherwise = node.getOtherwiseEdge();
    const trieNode = trie.build(Array.from(node));
    if (trieNode === undefined) {
      const result = new frontend.node.Empty<N>(this.id.id(node.name));
      return [ new this.implementation.node.Empty(result) ];
    }

    const children: N[] = [];
    this.translateTrie(node, trieNode, children);
    assert(children.length >= 1);

    return children;
  }

  private translateTrie(node: source.node.Match, trie: TrieNode,
                        children: N[]): N {
    if (trie instanceof TrieEmpty) {
      assert(this.map.has(node));
      return this.translate(trie.node);
    } else if (trie instanceof TrieSingle) {
      return this.translateSingle(node, trie, children);
    } else if (trie instanceof TrieSequence) {
      return this.translateSequence(node, trie, children);
    } else {
      throw new Error('Unknown trie node');
    }
  }

  private translateSingle(node: source.node.Match, trie: TrieSingle,
                          children: N[]): N {
    // See if we can apply TableLookup optimization
    const maybeTable = this.maybeTableLookup(node, trie, children);
    if (maybeTable !== undefined) {
      return maybeTable;
    }

    const ref = new frontend.node.Single<N>(this.id.id(node.name));
    const single = new this.implementation.node.Single(ref);
    children.push(single);

    // Break the loop
    if (!this.map.has(node)) {
      this.map.set(node, single);
    }
    for (const child of trie.children) {
      const childNode = this.translateTrie(node, child.node, children);

      ref.addEdge({
        key: child.key,
        noAdvance: child.noAdvance,
        node: childNode,
        value: child.node instanceof TrieEmpty ? child.node.value : undefined,
      });
    }
    return single;
  }

  private maybeTableLookup(node: source.node.Match, trie: TrieSingle,
                           children: N[]): N | undefined {
    if (trie.children.length < this.options.minTableSize) {
      debug('not enough children of "%s" to allocate table, got %d need %d',
        node.name, trie.children.length, this.options.minTableSize);
      return undefined;
    }

    const targets: Map<source.node.Node, ITableLookupTarget> = new Map();

    const bailout = !trie.children.every((child) => {
      if (!(child.node instanceof TrieEmpty)) {
        debug('non-leaf trie child of "%s" prevents table allocation',
          node.name);
        return false;
      }

      const empty: TrieEmpty = child.node;

      // We can't pass values from the table yet
      if (empty.value !== undefined) {
        debug('value passing trie leaf of "%s" prevents table allocation',
          node.name);
        return false;
      }

      const target = empty.node;
      if (!targets.has(target)) {
        targets.set(target, {
          keys: [ child.key ],
          noAdvance: child.noAdvance,
          trie: empty,
        });
        return true;
      }

      const existing = targets.get(target)!;

      // TODO(indutny): just use it as a sub-key?
      if (existing.noAdvance !== child.noAdvance) {
        debug(
          'noAdvance mismatch in a trie leaf of "%s" prevents ' +
            'table allocation',
          node.name);
        return false;
      }

      existing.keys.push(child.key);
      return true;
    });

    if (bailout) {
      return undefined;
    }

    // We've width limit for this optimization
    if (targets.size >= (1 << this.options.maxTableElemWidth)) {
      debug('too many different trie targets of "%s" for a table allocation',
        node.name);
      return undefined;
    }

    const ref = new frontend.node.TableLookup<N>(this.id.id(node.name));
    const table = new this.implementation.node.TableLookup(ref);
    children.push(table);

    // Break the loop
    if (!this.map.has(node)) {
      this.map.set(node, table);
    }

    targets.forEach((target) => {
      const next = this.translateTrie(node, target.trie, children);

      ref.addEdge({
        keys: target.keys,
        noAdvance: target.noAdvance,
        node: next,
      });
    });

    debug('optimized "%s" to a table lookup node', node.name);
    return table;
  }

  private translateSequence(node: source.node.Match, trie: TrieSequence,
                            children: N[]): N {
    const ref = new frontend.node.Sequence<N>(
      this.id.id(node.name), trie.select);
    const sequence = new this.implementation.node.Sequence(ref);
    children.push(sequence);

    // Break the loop
    if (!this.map.has(node)) {
      this.map.set(node, sequence);
    }

    const childNode = this.translateTrie(node, trie.child, children);

    const value = trie.child instanceof TrieEmpty ?
      trie.child.value : undefined;

    ref.setEdge(childNode, value);

    return sequence;
  }

  private translateCode(code: source.code.Code): frontend.code.Code {
    const prefixed = this.codeId.id(code.name).name;

    let res: frontend.code.Code;
    if (code instanceof source.code.IsEqual) {
      res = new frontend.code.IsEqual(prefixed, code.field, code.value);
    } else if (code instanceof source.code.Load) {
      res = new frontend.code.Load(prefixed, code.field);
    } else if (code instanceof source.code.MulAdd) {
      res = new frontend.code.MulAdd(prefixed, code.field, {
        base: code.options.base,
        max: code.options.max,
        signed: code.options.signed === undefined ? true : code.options.signed,
      });
    } else if (code instanceof source.code.Or) {
      res = new frontend.code.Or(prefixed, code.field, code.value);
    } else if (code instanceof source.code.Store) {
      res = new frontend.code.Store(prefixed, code.field);
    } else if (code instanceof source.code.Test) {
      res = new frontend.code.Test(prefixed, code.field, code.value);
    } else if (code instanceof source.code.Update) {
      res = new frontend.code.Update(prefixed, code.field, code.value);

    // External callbacks
    } else if (code instanceof source.code.Match) {
      res = new frontend.code.Match(code.name);
    } else if (code instanceof source.code.Span) {
      res = new frontend.code.Span(code.name);
    } else if (code instanceof source.code.Value) {
      res = new frontend.code.Value(code.name);
    } else {
      throw new Error(`Unsupported code: "${code.name}"`);
    }

    // Re-use instances to build them just once
    if (this.codeCache.has(res.cacheKey)) {
      return this.codeCache.get(res.cacheKey)!;
    }

    this.codeCache.set(res.cacheKey, res);
    return res;
  }

  private translateTransform(transform?: source.transform.Transform)
    : frontend.transform.Transform {
    if (transform === undefined) {
      return new frontend.transform.ID();
    } else if (transform.name === 'to_lower_unsafe') {
      return new frontend.transform.ToLowerUnsafe();
    } else {
      throw new Error(`Unsupported transform: "${transform.name}"`);
    }
  }
}
