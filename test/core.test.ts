import{expect,it}from'vitest';import{paeth}from'../src/index.js';it('predicts',()=>expect(paeth(10,20,15)).toBe(15));
