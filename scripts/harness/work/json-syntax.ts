type AfterValue = 'complete' | 'object-delimiter' | 'array-delimiter';
type Expectation =
  | AfterValue
  | 'document'
  | 'object-start'
  | 'object-key'
  | 'object-colon'
  | 'object-value'
  | 'array-start'
  | 'array-value';

type NumberPart =
  | 'sign'
  | 'zero'
  | 'integer'
  | 'point'
  | 'fraction'
  | 'exponent'
  | 'exponent-sign'
  | 'exponent-digits';

function invalidJson(): never {
  throw new SyntaxError('Invalid JSON record');
}

function numberEnds(part: NumberPart) {
  return part === 'zero' || part === 'integer' || part === 'fraction' || part === 'exponent-digits';
}

function nextNumberPart(part: NumberPart, character: string): NumberPart | undefined {
  if (character >= '0' && character <= '9') {
    if (part === 'sign') return character === '0' ? 'zero' : 'integer';
    if (part === 'point') return 'fraction';
    if (part === 'exponent' || part === 'exponent-sign') return 'exponent-digits';
    if (part !== 'zero') return part;
  }
  if (part === 'zero' || part === 'integer' || part === 'fraction') {
    if (character === 'e' || character === 'E') return 'exponent';
    if (part !== 'fraction' && character === '.') return 'point';
  }
  if (part === 'exponent' && (character === '+' || character === '-')) return 'exponent-sign';
}

/** Check a JSON value across chunks without retaining strings, numbers or other value contents. */
export class JsonSyntax {
  #expect: Expectation = 'document';
  #parents: AfterValue[] = [];
  #string: 'text' | 'escape' | null = null;
  #hexRemaining = 0;
  #literal = '';
  #number: NumberPart | undefined;

  push(text: string) {
    for (const character of text) {
      if (this.#string) {
        this.#readString(character);
        continue;
      }
      if (this.#literal) {
        if (character !== this.#literal[0]) invalidJson();
        this.#literal = this.#literal.slice(1);
        continue;
      }
      if (this.#number) {
        const next = nextNumberPart(this.#number, character);
        if (next) {
          this.#number = next;
          continue;
        }
        if (!numberEnds(this.#number)) invalidJson();
        this.#number = undefined;
      }
      if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n')
        this.#readStructure(character);
    }
  }

  finish() {
    if (
      this.#expect !== 'complete' ||
      this.#string ||
      this.#literal ||
      (this.#number && !numberEnds(this.#number))
    )
      invalidJson();
  }

  #readString(character: string) {
    if (this.#hexRemaining > 0) {
      if (!/^[\da-fA-F]$/.test(character)) invalidJson();
      this.#hexRemaining--;
    } else if (this.#string === 'escape') {
      if (character === 'u') this.#hexRemaining = 4;
      else if (!'"\\/bfnrt'.includes(character)) invalidJson();
      this.#string = 'text';
    } else if (character === '"') {
      this.#string = null;
    } else if (character === '\\') {
      this.#string = 'escape';
    } else if (character < ' ') {
      invalidJson();
    }
  }

  #readStructure(character: string) {
    switch (this.#expect) {
      case 'document':
        return this.#startValue(character, 'complete');
      case 'object-start':
      case 'object-key':
        if (this.#expect === 'object-start' && character === '}') {
          this.#expect = this.#parents.pop()!;
        } else if (character === '"') {
          this.#string = 'text';
          this.#expect = 'object-colon';
        } else invalidJson();
        return;
      case 'object-colon':
        if (character !== ':') invalidJson();
        this.#expect = 'object-value';
        return;
      case 'object-value':
        return this.#startValue(character, 'object-delimiter');
      case 'object-delimiter':
        if (character === '}') this.#expect = this.#parents.pop()!;
        else if (character === ',') this.#expect = 'object-key';
        else invalidJson();
        return;
      case 'array-start':
        if (character === ']') {
          this.#expect = this.#parents.pop()!;
          return;
        }
        return this.#startValue(character, 'array-delimiter');
      case 'array-value':
        return this.#startValue(character, 'array-delimiter');
      case 'array-delimiter':
        if (character === ']') this.#expect = this.#parents.pop()!;
        else if (character === ',') this.#expect = 'array-value';
        else invalidJson();
        return;
      case 'complete':
        return invalidJson();
    }
  }

  #startValue(character: string, after: AfterValue) {
    this.#expect = after;
    if (character === '{' || character === '[') {
      this.#parents.push(after);
      this.#expect = character === '{' ? 'object-start' : 'array-start';
    } else if (character === '"') {
      this.#string = 'text';
    } else if (character === 't') {
      this.#literal = 'rue';
    } else if (character === 'f') {
      this.#literal = 'alse';
    } else if (character === 'n') {
      this.#literal = 'ull';
    } else if (character === '-') {
      this.#number = 'sign';
    } else if (character === '0') {
      this.#number = 'zero';
    } else if (character >= '1' && character <= '9') {
      this.#number = 'integer';
    } else invalidJson();
  }
}
