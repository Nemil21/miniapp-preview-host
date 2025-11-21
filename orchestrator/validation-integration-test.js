#!/usr/bin/env node

// Simple integration test for validation endpoint
// Tests real scenarios by calling the /validate endpoint directly

import http from 'http';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test configuration
const SERVER_PORT = 3002;
const SERVER_HOST = 'localhost';
const BASE_URL = `http://${SERVER_HOST}:${SERVER_PORT}`;

let serverProcess = null;

// Start the server for testing
async function startServer() {
  return new Promise((resolve, reject) => {
    console.log('🚀 Starting server for testing...');
    
    serverProcess = spawn('node', ['index.js'], {
      cwd: __dirname,
      env: { ...process.env, PORT: SERVER_PORT, PREVIEW_AUTH_TOKEN: 'test-token' }
    });

    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      if (output.includes('Listening on') || output.includes('listening')) {
        console.log('✅ Server started successfully');
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('Server error:', data.toString());
    });

    serverProcess.on('error', (error) => {
      console.error('Failed to start server:', error);
      reject(error);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      reject(new Error('Server startup timeout'));
    }, 10000);
  });
}

// Stop the server
function stopServer() {
  if (serverProcess) {
    console.log('🛑 Stopping server...');
    serverProcess.kill();
    serverProcess = null;
  }
}

// Make HTTP request to validation endpoint
async function validateCode(projectId, files, validationConfig = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      projectId,
      files,
      validationConfig: {
        enableTypeScript: true,
        enableSolidity: true,
        enableESLint: false, // Disabled - ESLint is ignored in production builds (next.config.ts)
        enableBuild: true,
        enableRuntimeChecks: true,
        ...validationConfig
      }
    });

    const options = {
      hostname: SERVER_HOST,
      port: SERVER_PORT,
      path: '/validate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': 'Bearer test-token' // Add auth header for testing
      }
    };

    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve({ status: res.statusCode, data: result });
        } catch (error) {
          reject(new Error(`Failed to parse response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

// Test scenarios
const testScenarios = {
  // Valid TypeScript React component
  validTypeScript: {
    name: 'Valid TypeScript React Component',
    files: {
      'src/components/ValidComponent.tsx': `'use client';

import React, { useState } from 'react';

interface Props {
  title: string;
  count: number;
}

export function ValidComponent({ title, count }: Props) {
  const [value, setValue] = useState(0);
  
  return (
    <div>
      <h1>{title}</h1>
      <p>Count: {count}</p>
      <p>Value: {value}</p>
      <button onClick={() => setValue(value + 1)}>
        Increment
      </button>
    </div>
  );
}`
    },
    expectedSuccess: true
  },

  // Invalid TypeScript - type mismatch
  invalidTypeScript: {
    name: 'Invalid TypeScript - Type Mismatch',
    files: {
      'src/components/InvalidComponent.tsx': `'use client';

import React from 'react';

interface Props {
  count: number;
  name: string;
}

export function InvalidComponent({ count, name }: Props) {
  // Type error: string assigned to number
  const invalidCount: number = name;
  
  // Type error: number used as string
  const invalidName: string = count;
  
  return (
    <div>
      <p>Count: {invalidCount}</p>
      <p>Name: {invalidName}</p>
    </div>
  );
}`
    },
    expectedSuccess: false
  },

  // Invalid TypeScript - missing property
  missingProperty: {
    name: 'Invalid TypeScript - Missing Property',
    files: {
      'src/components/MissingPropComponent.tsx': `'use client';

import React from 'react';

interface TodoItem {
  id: string;
  text: string;
  completed: boolean;
}

interface TodoListProps {
  todos: TodoItem[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function TodoList({ todos, onToggle }: TodoListProps) {
  // Missing onDelete prop - should cause error
  return (
    <div>
      {todos.map(todo => (
        <div key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => onToggle(todo.id)}
          />
          <span>{todo.text}</span>
          <button onClick={() => onDelete(todo.id)}>
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}`
    },
    expectedSuccess: false
  },

  // Invalid TypeScript - undefined variables
  undefinedVariables: {
    name: 'Invalid TypeScript - Undefined Variables',
    files: {
      'src/components/UndefinedVarComponent.tsx': `'use client';

import React from 'react';

export function UndefinedVarComponent() {
  // Using undefined variables
  const result = someUndefinedFunction();
  const value = someObject.undefinedProperty;
  
  return (
    <div>
      <p>Result: {result}</p>
      <p>Value: {value}</p>
    </div>
  );
}`
    },
    expectedSuccess: false
  },

  // Invalid TypeScript - missing imports
  missingImports: {
    name: 'Invalid TypeScript - Missing Imports',
    files: {
      'src/components/MissingImportComponent.tsx': `'use client';

// Missing React import but using JSX
export function MissingImportComponent() {
  const [count, setCount] = useState(0); // Missing useState import
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </div>
  );
}`
    },
    expectedSuccess: false
  },

  // Valid Solidity contract
  validSolidity: {
    name: 'Valid Solidity Contract',
    files: {
      'contracts/ValidContract.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract ValidContract {
    uint256 public value;
    address public owner;
    
    event ValueChanged(uint256 newValue);
    
    constructor() {
        owner = msg.sender;
    }
    
    function setValue(uint256 _value) public {
        require(msg.sender == owner, "Only owner can set value");
        value = _value;
        emit ValueChanged(_value);
    }
    
    function getValue() public view returns (uint256) {
        return value;
    }
}`
    },
    expectedSuccess: true
  },

  // Invalid Solidity - type conversion error
  invalidSolidity: {
    name: 'Invalid Solidity - Type Conversion Error',
    files: {
      'contracts/InvalidContract.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InvalidContract {
    function testFunction() public {
        // Type conversion errors
        uint256 x = "invalid"; // String to uint256 conversion error
        string memory y = 123; // Number to string conversion error
    }
}`
    },
    expectedSuccess: false
  },

  // Invalid Solidity - syntax error
  soliditySyntaxError: {
    name: 'Invalid Solidity - Syntax Error',
    files: {
      'contracts/SyntaxErrorContract.sol': `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract SyntaxErrorContract {
    function testFunction() public {
        // Missing semicolons
        uint256 x = 123
        string memory y = "hello"
        bool z = true
        
        // Missing closing brace
    }
}`
    },
    expectedSuccess: false
  },

  // Valid Next.js page
  validNextJs: {
    name: 'Valid Next.js Page',
    files: {
      'src/app/layout.tsx': `import './globals.css';

export const metadata = {
  title: 'Test App',
  description: 'A test application'
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}`,
      'src/app/page.tsx': `'use client';

import { useState } from 'react';

export default function HomePage() {
  const [count, setCount] = useState(0);
  
  return (
    <div>
      <h1>Welcome to Test App</h1>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </div>
  );
}`,
      'src/app/globals.css': `body {
  margin: 0;
  padding: 20px;
  font-family: Arial, sans-serif;
}`
    },
    expectedSuccess: true
  },

  // Invalid Next.js - missing dependencies
  invalidNextJs: {
    name: 'Invalid Next.js - Missing Dependencies',
    files: {
      'src/app/page.tsx': `'use client';

import { useState } from 'react';
import { SomeNonExistentComponent } from '@/components/NonExistent';

export default function HomePage() {
  const [count, setCount] = useState(0);
  
  return (
    <div>
      <h1>Welcome</h1>
      <SomeNonExistentComponent />
      <p>Count: {count}</p>
    </div>
  );
}`
    },
    expectedSuccess: false
  },

  // Runtime check - missing use client
  missingUseClient: {
    name: 'Runtime Check - Missing use client directive',
    files: {
      'src/components/MissingUseClientComponent.tsx': `import { useState } from 'react';

export function MissingUseClientComponent() {
  const [count, setCount] = useState(0);
  
  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </div>
  );
}`
    },
    expectedSuccess: false
  },

  // Runtime check - potential memory leak
  memoryLeak: {
    name: 'Runtime Check - Potential Memory Leak',
    files: {
      'src/components/MemoryLeakComponent.tsx': `'use client';

import { useState, useEffect } from 'react';

export function MemoryLeakComponent() {
  const [count, setCount] = useState(0);
  
  useEffect(() => {
    const interval = setInterval(() => {
      setCount(prev => prev + 1);
    }, 1000);
    
    // Missing cleanup - potential memory leak
  }, []);
  
  return (
    <div>
      <p>Count: {count}</p>
    </div>
  );
}`
    },
    expectedSuccess: false
  },

  // Complete valid application
  completeValidApp: {
    name: 'Complete Valid Application',
    files: {
      'src/app/layout.tsx': `import './globals.css';

export const metadata = {
  title: 'Todo App',
  description: 'A comprehensive todo application'
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}`,
      'src/app/page.tsx': `'use client';

import { useState } from 'react';
import { TodoList } from '@/components/TodoList';

interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

export default function HomePage() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [newTodo, setNewTodo] = useState('');
  
  const addTodo = () => {
    if (newTodo.trim()) {
      const todo: Todo = {
        id: Date.now().toString(),
        text: newTodo.trim(),
        completed: false
      };
      setTodos(prev => [...prev, todo]);
      setNewTodo('');
    }
  };
  
  const toggleTodo = (id: string) => {
    setTodos(prev => prev.map(todo => 
      todo.id === id ? { ...todo, completed: !todo.completed } : todo
    ));
  };
  
  const deleteTodo = (id: string) => {
    setTodos(prev => prev.filter(todo => todo.id !== id));
  };
  
  return (
    <div>
      <h1>Todo App</h1>
      <div>
        <input
          value={newTodo}
          onChange={(e) => setNewTodo(e.target.value)}
          placeholder="Add new todo"
        />
        <button onClick={addTodo}>Add</button>
      </div>
      <TodoList 
        todos={todos} 
        onToggle={toggleTodo}
        onDelete={deleteTodo}
      />
    </div>
  );
}`,
      'src/components/TodoList.tsx': `'use client';

interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

interface TodoListProps {
  todos: Todo[];
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function TodoList({ todos, onToggle, onDelete }: TodoListProps) {
  return (
    <ul>
      {todos.map(todo => (
        <li key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => onToggle(todo.id)}
          />
          <span style={{ textDecoration: todo.completed ? 'line-through' : 'none' }}>
            {todo.text}
          </span>
          <button onClick={() => onDelete(todo.id)}>
            Delete
          </button>
        </li>
      ))}
    </ul>
  );
}`,
      'src/app/globals.css': `body {
  margin: 0;
  padding: 20px;
  font-family: Arial, sans-serif;
}

ul {
  list-style: none;
  padding: 0;
}

li {
  margin: 10px 0;
  padding: 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
}`
    },
    expectedSuccess: true
  }
};

// Run a single test
async function runTest(testName, testCase) {
  console.log(`\n🧪 Running test: ${testCase.name}`);
  console.log(`📝 Files: ${Object.keys(testCase.files).join(', ')}`);
  
  try {
    const result = await validateCode(testName, testCase.files);
    
    if (result.status !== 200) {
      console.log(`❌ Test failed: HTTP ${result.status}`);
      return false;
    }
    
    const { success, errors, warnings, compilationTime } = result.data;
    
    console.log(`⏱️  Compilation time: ${compilationTime}ms`);
    console.log(`📊 Success: ${success}`);
    console.log(`❌ Errors: ${errors.length}`);
    console.log(`⚠️  Warnings: ${warnings.length}`);
    
    if (errors.length > 0) {
      console.log(`🔍 Error details:`);
      errors.forEach((error, index) => {
        console.log(`   ${index + 1}. ${error.file}:${error.line}:${error.column} - ${error.message}`);
      });
    }
    
    if (warnings.length > 0) {
      console.log(`⚠️  Warning details:`);
      warnings.forEach((warning, index) => {
        console.log(`   ${index + 1}. ${warning.file}:${warning.line}:${warning.column} - ${warning.message}`);
      });
    }
    
    const testPassed = success === testCase.expectedSuccess;
    console.log(`✅ Test ${testPassed ? 'PASSED' : 'FAILED'}`);
    
    return testPassed;
    
  } catch (error) {
    console.log(`❌ Test failed with error: ${error.message}`);
    return false;
  }
}

// Run all tests
async function runAllTests() {
  console.log('🚀 Starting Validation Integration Tests');
  console.log('=====================================');
  
  try {
    // Start server
    await startServer();
    
    // Wait a bit for server to be ready
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    let passedTests = 0;
    let totalTests = 0;
    
    // Run each test scenario
    for (const [testName, testCase] of Object.entries(testScenarios)) {
      totalTests++;
      const passed = await runTest(testName, testCase);
      if (passed) passedTests++;
      
      // Wait between tests to avoid overwhelming the server
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Summary
    console.log('\n📊 Test Summary');
    console.log('===============');
    console.log(`✅ Passed: ${passedTests}/${totalTests}`);
    console.log(`❌ Failed: ${totalTests - passedTests}/${totalTests}`);
    console.log(`📈 Success rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);
    
    if (passedTests === totalTests) {
      console.log('\n🎉 All tests passed! Validation system is working correctly.');
    } else {
      console.log('\n⚠️  Some tests failed. Please review the validation system.');
    }
    
  } catch (error) {
    console.error('❌ Test suite failed:', error.message);
  } finally {
    // Stop server
    stopServer();
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\n🛑 Test interrupted by user');
  stopServer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Test terminated');
  stopServer();
  process.exit(0);
});

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllTests().catch(error => {
    console.error('❌ Test suite failed:', error);
    process.exit(1);
  });
}
