// orchestrator/index.js — full file

import 'dotenv/config'; // Load .env file automatically
import express from "express";
import bodyParser from "body-parser";
import http from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import httpProxy from "http-proxy"; // CJS default import
import { RailwayCompilationValidator } from "./validation.js";


/* ========= Config ========= */
const PORT = process.env.PORT || 8080;

// Environment detection
const IS_RAILWAY = process.env.RAILWAY_ENVIRONMENT === "true" || process.env.FORCE_EXTERNAL_DEPLOYMENT === "true";
const IS_LOCAL = !IS_RAILWAY;

// Paths (env-overridable, Railway-optimized)
// Default paths based on environment for Farcaster boilerplate
const DEFAULT_FARCASTER_BOILERPLATE = IS_LOCAL 
  ? path.join(process.cwd(), "..", "boilerplate")  // Local: relative to orchestrator dir (fallback to old name)
  : "/srv/boilerplate-farcaster";  // Production: Docker build path

// Default paths based on environment for Web3 boilerplate
const DEFAULT_WEB3_BOILERPLATE = IS_LOCAL 
  ? path.join(process.cwd(), "..", "..", "web3-boilerplate")  // Local: relative to orchestrator dir
  : "/srv/boilerplate-web3";  // Production: Docker build path

const FARCASTER_BOILERPLATE = process.env.FARCASTER_BOILERPLATE_DIR || DEFAULT_FARCASTER_BOILERPLATE;
const WEB3_BOILERPLATE = process.env.WEB3_BOILERPLATE_DIR || DEFAULT_WEB3_BOILERPLATE;

// Helper function to get the appropriate boilerplate based on app type
function getBoilerplatePath(isWeb3 = false) {
  return isWeb3 ? WEB3_BOILERPLATE : FARCASTER_BOILERPLATE;
}
const PREVIEWS_ROOT = IS_RAILWAY 
  ? (process.env.PREVIEWS_ROOT || "/tmp/previews")  // Use /tmp for Railway
  : (process.env.PREVIEWS_ROOT || "/srv/previews"); // Use /srv for local
const PNPM_STORE = IS_RAILWAY
  ? (process.env.PNPM_STORE_DIR || "/tmp/.pnpm-store")  // Use /tmp for Railway
  : (process.env.PNPM_STORE_DIR || path.join(PREVIEWS_ROOT, ".pnpm-store")); // Use /srv for local

// Auth (Bearer) for management endpoints only
const AUTH_TOKEN = process.env.PREVIEW_AUTH_TOKEN || "";

// Dev port base (only used for local deployments)
const BASE_PORT = Number(process.env.BASE_PORT || 4000);

// Deployment feature flags
const ENABLE_VERCEL_DEPLOYMENT = process.env.ENABLE_VERCEL_DEPLOYMENT === "true";
const ENABLE_NETLIFY_DEPLOYMENT = process.env.ENABLE_NETLIFY_DEPLOYMENT === "true";
const ENABLE_CONTRACT_DEPLOYMENT = process.env.ENABLE_CONTRACT_DEPLOYMENT === "true";
const DEPLOYMENT_TOKEN_SECRET = process.env.DEPLOYMENT_TOKEN_SECRET || "";
const RETURN_DEPLOYMENT_ERRORS = process.env.RETURN_DEPLOYMENT_ERRORS === "true"; // Return errors instead of falling back to local
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN || "";
const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

// Custom domain configuration
const CUSTOM_DOMAIN_BASE = process.env.CUSTOM_DOMAIN_BASE || "minidev.fun"; // Base domain for custom subdomains
// NOTE: Custom domains disabled by default - each subdomain requires DNS verification
// For multi-tenant platforms, use the subdomain router approach (see SUBDOMAIN_ROUTER_SOLUTION.md)
const ENABLE_CUSTOM_DOMAINS = process.env.ENABLE_CUSTOM_DOMAINS === "true"; // Enable custom domain assignment
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";

// Railway-specific: Force external deployment
const FORCE_EXTERNAL_DEPLOYMENT = process.env.FORCE_EXTERNAL_DEPLOYMENT === "true";

// Miniapp creator URL for callbacks (job status updates)
const MINIAPP_CREATOR_URL = process.env.MINIAPP_CREATOR_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

/* ========= Small utils ========= */

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function makeRing(cap = 4000) {
  const buf = [];
  return {
    push: (s) => {
      buf.push(s);
      if (buf.length > cap) buf.shift();
    },
    text: () => buf.join(""),
  };
}

  /**
 * Extract meaningful error from deployment logs
 */
function extractErrorFromLogs(logs) {
  if (!logs) return null;
  
  // Try to find TypeScript errors
  const tsErrorMatch = logs.match(/Type error:([^\n]+(?:\n(?![\s]*$)[^\n]+)*)/);
  if (tsErrorMatch) {
    return `TypeScript Error: ${tsErrorMatch[1].trim()}`;
  }
  
  // Try to find ESLint errors
  const eslintErrorMatch = logs.match(/Error:([^\n]+(?:\n(?![\s]*$)[^\n]+)*)/);
  if (eslintErrorMatch) {
    return `Build Error: ${eslintErrorMatch[1].trim()}`;
  }
  
  // Try to find "Failed to compile" errors
  const compileErrorMatch = logs.match(/Failed to compile\.([\s\S]{0,500})/);
  if (compileErrorMatch) {
    return `Compilation Failed: ${compileErrorMatch[1].trim()}`;
  }
  
  return null;
}

/**
 * Notify miniapp-creator that a job has failed due to background deployment failure
 */
async function notifyJobFailure(jobId, projectId, error, logs) {
  if (!jobId) {
    console.log(`[${projectId}] No jobId provided, skipping job failure notification`);
    return;
  }

  try {
    console.log(`[${projectId}] 📞 Notifying miniapp-creator of job failure for jobId: ${jobId}`);
    
    // Extract detailed error from logs
    const detailedError = extractErrorFromLogs(logs);
    const deploymentError = detailedError || error || 'Background deployment failed';
    
    console.log(`[${projectId}] 📋 Detailed error: ${deploymentError.substring(0, 200)}`);
    
    const response = await fetch(`${MINIAPP_CREATOR_URL}/api/jobs/${jobId}/fail`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        error: error || 'Background deployment failed',
        logs: logs || '',
        deploymentError: deploymentError
      })
    });

    if (response.ok) {
      console.log(`[${projectId}] ✅ Job ${jobId} marked as failed in database`);
    } else {
      const errorText = await response.text();
      console.error(`[${projectId}] ❌ Failed to notify job failure: ${response.status} ${errorText}`);
    }
  } catch (notifyError) {
    console.error(`[${projectId}] ❌ Error notifying job failure:`, notifyError.message);
  }
}

/* ========= Deployment helpers ========= */

/**
 * Disable deployment protection for a Vercel project
 */
async function disableVercelDeploymentProtection(vercelProjectId, teamId = null) {
  try {
    console.log(`[${vercelProjectId}] 🔓 Disabling deployment protection...`);
    
    // Build API URL with team ID if provided
    let apiUrl = `https://api.vercel.com/v1/projects/${vercelProjectId}`;
    if (teamId) {
      apiUrl += `?teamId=${teamId}`;
      console.log(`[${vercelProjectId}] Using team ID: ${teamId}`);
    }
    
    // Update project settings to disable all protection types
    const response = await fetch(apiUrl, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${DEPLOYMENT_TOKEN_SECRET}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ssoProtection: null,           // Disable SSO protection
        passwordProtection: null       // Disable password protection
        // Note: Don't set trustedIps to empty array - it requires at least 1 item
        // Omitting it leaves it unchanged, which is fine
      })
    });

    if (response.ok) {
      console.log(`[${vercelProjectId}] ✅ Deployment protection disabled`);
      return true;
    } else {
      const error = await response.text();
      console.warn(`[${vercelProjectId}] ⚠️ Failed to disable deployment protection: ${response.status} ${error}`);
      // Log response for debugging
      try {
        const errorJson = JSON.parse(error);
        console.warn(`[${vercelProjectId}] Error details:`, JSON.stringify(errorJson, null, 2));
      } catch (e) {
        console.warn(`[${vercelProjectId}] Raw error:`, error);
      }
      return false;
    }
  } catch (error) {
    console.warn(`[${vercelProjectId}] ⚠️ Error disabling deployment protection:`, error.message);
    return false;
  }
}

/**
 * Assign custom domain to Vercel project
 * @param {string} vercelProjectId - The Vercel project ID
 * @param {string} projectId - The project ID (used as subdomain)
 * @param {string|null} teamId - The Vercel team ID (if deploying to a team)
 * @returns {Promise<string|null>} - The custom domain URL if successful, null otherwise
 */
async function assignCustomDomain(vercelProjectId, projectId, teamId = null) {
  if (!ENABLE_CUSTOM_DOMAINS) {
    console.log(`[${projectId}] Custom domains disabled, skipping`);
    return null;
  }

  try {
    const customDomain = `${projectId}.${CUSTOM_DOMAIN_BASE}`;
    console.log(`[${projectId}] 🌐 Assigning custom domain: ${customDomain}`);
    
    // Build API URL with team ID if provided
    let apiUrl = `https://api.vercel.com/v10/projects/${vercelProjectId}/domains`;
    if (teamId) {
      apiUrl += `?teamId=${teamId}`;
      console.log(`[${projectId}] Using team ID for domain assignment: ${teamId}`);
    }
    
    // Add domain to Vercel project
    const addDomainResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DEPLOYMENT_TOKEN_SECRET}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: customDomain
      })
    });

    if (addDomainResponse.ok) {
      const domainData = await addDomainResponse.json();
      console.log(`[${projectId}] ✅ Custom domain assigned: ${customDomain}`);
      console.log(`[${projectId}] Domain verification required: ${domainData.verified === false ? 'Yes (DNS should auto-verify if configured)' : 'No'}`);
      
      return `https://${customDomain}`;
    } else {
      const errorText = await addDomainResponse.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {
        errorData = { message: errorText };
      }
      
      // Check if domain already exists
      if (addDomainResponse.status === 409 || errorData.error?.code === 'domain_already_exists') {
        console.log(`[${projectId}] ℹ️ Custom domain already exists: ${customDomain}`);
        console.log(`[${projectId}] 🔄 Checking if domain is assigned to correct project...`);
        
        // Try to remove from all projects and re-add to this one
        try {
          // First, find which project it's assigned to
          const domainsResponse = await fetch(`https://api.vercel.com/v6/domains/${customDomain}`, {
            headers: {
              'Authorization': `Bearer ${DEPLOYMENT_TOKEN_SECRET}`
            }
          });
          
          if (domainsResponse.ok) {
            const domainInfo = await domainsResponse.json();
            console.log(`[${projectId}] 📋 Domain currently points to project: ${domainInfo.projectId || 'unknown'}`);
            
            // If it's assigned to a different project, remove it first
            if (domainInfo.projectId && domainInfo.projectId !== vercelProjectId) {
              console.log(`[${projectId}] 🗑️ Removing domain from old project: ${domainInfo.projectId}`);
              
              const removeResponse = await fetch(`https://api.vercel.com/v9/projects/${domainInfo.projectId}/domains/${customDomain}`, {
                method: 'DELETE',
                headers: {
                  'Authorization': `Bearer ${DEPLOYMENT_TOKEN_SECRET}`
                }
              });
              
              if (removeResponse.ok || removeResponse.status === 404) {
                console.log(`[${projectId}] ✅ Domain removed from old project`);
                
                // Now try to add it to the new project
                const retryAddResponse = await fetch(`https://api.vercel.com/v10/projects/${vercelProjectId}/domains`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${DEPLOYMENT_TOKEN_SECRET}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                    name: customDomain
                  })
                });
                
                if (retryAddResponse.ok) {
                  console.log(`[${projectId}] ✅ Domain re-assigned to new project`);
                  return `https://${customDomain}`;
                } else {
                  console.warn(`[${projectId}] ⚠️ Failed to re-assign domain:`, await retryAddResponse.text());
                }
              }
            } else {
              console.log(`[${projectId}] ℹ️ Domain is already assigned to this project`);
            }
          }
        } catch (reassignError) {
          console.warn(`[${projectId}] ⚠️ Error reassigning domain:`, reassignError.message);
        }
        
        return `https://${customDomain}`;
      }
      
      console.warn(`[${projectId}] ⚠️ Failed to assign custom domain: ${addDomainResponse.status}`);
      console.warn(`[${projectId}] Error details:`, JSON.stringify(errorData, null, 2));
      return null;
    }
  } catch (error) {
    console.warn(`[${projectId}] ⚠️ Error assigning custom domain:`, error.message);
    return null;
  }
}

async function deployToVercel(dir, projectId, logs) {
  if (!ENABLE_VERCEL_DEPLOYMENT || !DEPLOYMENT_TOKEN_SECRET) {
    throw new Error("Vercel deployment is disabled or token not provided");
  }

  console.log(`[${projectId}] 🌐 Deploying to Vercel...`);
  
  try {
    // Set up environment variables
    const env = {
      ...process.env,
      DEPLOYMENT_TOKEN_SECRET,
    };

    // Always use npx for Vercel CLI to avoid installation issues
    console.log(`[${projectId}] Using npx to run Vercel CLI...`);
    
    // Deploy to Vercel using npx (more reliable in containerized environments)
    // Add --scope parameter if VERCEL_TEAM_ID is set (for team deployments)
    const vercelArgs = ["vercel", "--token", DEPLOYMENT_TOKEN_SECRET, "--name", projectId, "--prod", "--confirm", "--public"];
    
    // If deploying to a team, add scope
    const vercelTeam = process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID;
    if (vercelTeam) {
      console.log(`[${projectId}] Deploying to team/org: ${vercelTeam}`);
      vercelArgs.push("--scope", vercelTeam);
    }
    
    const result = await run("npx", vercelArgs, {
      id: projectId,
      cwd: dir,
      env: { ...env, DEPLOYMENT_TOKEN_SECRET, CI: "1" },
      logs
    });

    console.log(`[${projectId}] ✅ Vercel deployment completed`);

    // Extract deployment-specific URL from "Production:" line
    const output = result.output || result.stdout || '';
    const productionUrlMatch = output.match(/Production:\s+(https:\/\/[^\s]+\.vercel\.app)/);
    
    if (productionUrlMatch && productionUrlMatch[1]) {
      console.log(`[${projectId}] 📋 Deployment-specific URL: ${productionUrlMatch[1]}`);
    }

    // Get the actual stable domain from Vercel API
    // Vercel truncates domain names to 63 characters, so we need to query the API
    let stableUrl = `https://${projectId}.vercel.app`; // fallback
    
    try {
      // Read project ID from .vercel/project.json
      const vercelProjectPath = path.join(dir, ".vercel", "project.json");
      if (await exists(vercelProjectPath)) {
        const projectData = JSON.parse(await fs.readFile(vercelProjectPath, "utf8"));
        const vercelProjectId = projectData.projectId;
        
        if (vercelProjectId) {
          console.log(`[${projectId}] 📡 Fetching project info from Vercel API...`);
          
          // Get team ID if deploying to a team
          const vercelTeam = process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID;
          
          // Disable deployment protection for this project
          await disableVercelDeploymentProtection(vercelProjectId, vercelTeam);
          
          // Assign custom domain to this project
          const customDomainUrl = await assignCustomDomain(vercelProjectId, projectId, vercelTeam);
          
          // If custom domain was successfully assigned, use it
          if (customDomainUrl) {
            stableUrl = customDomainUrl;
            console.log(`[${projectId}] 🌐 Using custom domain: ${stableUrl}`);
          } else {
            // Fallback to querying Vercel API for default domain
            let projectApiUrl = `https://api.vercel.com/v9/projects/${vercelProjectId}`;
            if (vercelTeam) {
              projectApiUrl += `?teamId=${vercelTeam}`;
            }
            
            const response = await fetch(projectApiUrl, {
              headers: {
                'Authorization': `Bearer ${DEPLOYMENT_TOKEN_SECRET}`
              }
            });
            
            if (response.ok) {
              const projectInfo = await response.json();
              // Get the production domain (targets[0].alias)
              if (projectInfo.targets?.production?.alias?.[0]) {
                stableUrl = `https://${projectInfo.targets.production.alias[0]}`;
                console.log(`[${projectId}] 🌐 Vercel stable production URL from API: ${stableUrl}`);
              } else if (projectInfo.alias?.[0]) {
                stableUrl = `https://${projectInfo.alias[0]}`;
                console.log(`[${projectId}] 🌐 Vercel stable production URL from API: ${stableUrl}`);
              } else {
                console.warn(`[${projectId}] ⚠️ No alias found in API response, using fallback`);
              }
            } else {
              console.warn(`[${projectId}] ⚠️ Vercel API request failed: ${response.status}`);
            }
          }
        }
      }
    } catch (error) {
      console.warn(`[${projectId}] ⚠️ Could not fetch stable URL from Vercel API:`, error.message);
    }
    
    console.log(`[${projectId}] 🌐 Final stable production URL: ${stableUrl}`);
    return stableUrl;
    
  } catch (error) {
    console.error(`[${projectId}] ❌ Vercel deployment failed:`, error);
    throw error;
  }
}

async function deployToNetlify(dir, projectId, logs) {
  if (!ENABLE_NETLIFY_DEPLOYMENT || !NETLIFY_TOKEN) {
    throw new Error("Netlify deployment is disabled or token not provided");
  }

  console.log(`[${projectId}] 🌐 Deploying to Netlify...`);
  
  try {
    // Build the project first
    console.log(`[${projectId}] Building project...`);
    await run("npm", ["run", "build"], { id: projectId, cwd: dir, logs });

    // Always use npx for Netlify CLI to avoid installation issues
    console.log(`[${projectId}] Using npx to run Netlify CLI...`);
    await run("npx", ["netlify", "deploy", "--prod", "--auth", NETLIFY_TOKEN, "--dir", ".next"], { 
      id: projectId, 
      cwd: dir, 
      logs 
    });
    
    console.log(`[${projectId}] ✅ Netlify deployment completed`);
    return `https://${projectId}.netlify.app`;
    
  } catch (error) {
    console.error(`[${projectId}] ❌ Netlify deployment failed:`, error);
    throw error;
  }
}

async function deployContracts(dir, projectId, logs, skipContracts = false) {
  // Check skipContracts flag FIRST
  if (skipContracts) {
    console.log(`[${projectId}] skipContracts flag is true, skipping contract deployment`);
    return null;
  }

  if (!ENABLE_CONTRACT_DEPLOYMENT || !PRIVATE_KEY) {
    console.log(`[${projectId}] Contract deployment disabled or no private key provided`);
    return null;
  }

  const contractsDir = path.join(dir, "contracts");

  if (!(await exists(contractsDir))) {
    console.log(`[${projectId}] No contracts directory found, skipping contract deployment`);
    return null;
  }

  return await deployContractsFromPath(contractsDir, projectId, logs);
}

async function deployContractsFromPath(contractsDir, projectId, logs) {
  console.log(`[${projectId}] 🚀 Deploying contracts to Base Sepolia testnet...`);

  try {
    // Check for package.json in contracts directory
    const packageJsonPath = path.join(contractsDir, "package.json");
    if (!(await exists(packageJsonPath))) {
      console.log(`[${projectId}] No package.json found in contracts directory, skipping contract deployment`);
      return null;
    }

    // Install dependencies
    console.log(`[${projectId}] Installing contract dependencies...`);
    await run("npm", ["install"], { id: projectId, cwd: contractsDir, logs });

    // Clean previous compilation artifacts
    console.log(`[${projectId}] Cleaning previous compilation artifacts...`);
    try {
      await run("npx", ["hardhat", "clean"], { id: projectId, cwd: contractsDir, logs });
    } catch (error) {
      console.log(`[${projectId}] Clean command failed (this is okay if no previous artifacts):`, error.message);
    }

    // Compile contracts
    console.log(`[${projectId}] Compiling contracts...`);
    await run("npx", ["hardhat", "compile"], { id: projectId, cwd: contractsDir, logs });

    // Deploy to Base Sepolia
    console.log(`[${projectId}] Deploying to Base Sepolia testnet...`);
    const env = {
      ...process.env,
      PRIVATE_KEY,
      BASE_SEPOLIA_RPC_URL,
      HARDHAT_NETWORK: "baseSepolia"
    };

    await run("npx", ["hardhat", "run", "scripts/deploy.js", "--network", "baseSepolia"], {
      id: projectId,
      cwd: contractsDir,
      env,
      logs
    });

    console.log(`[${projectId}] ✅ Contract deployment completed`);

    // Read deployment info if available
    const deploymentInfoPath = path.join(contractsDir, "deployment-info.json");
    if (await exists(deploymentInfoPath)) {
      const deploymentInfo = await fs.readFile(deploymentInfoPath, "utf8");
      return JSON.parse(deploymentInfo);
    }

    return { contractAddress: "deployed-successfully" };

  } catch (error) {
    console.error(`[${projectId}] ❌ Contract deployment failed:`, error);
    throw error;
  }
}

/* ========= Process runner (logs to Railway + ring buffer) ========= */

function run(cmd, args, { id, cwd, env, logs } = {}) {
  return new Promise((resolve, reject) => {
    const label = id ? `[${id}]` : "";
    console.log(`${label} > ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let output = "";
    
    const onStdoutData = (d) => {
      const line = `${label} ${d.toString()}`;
      stdout += d.toString();
      output += d.toString();
      process.stdout.write(line);
      logs?.push(line);
    };
    
    const onStderrData = (d) => {
      const line = `${label} ${d.toString()}`;
      stderr += d.toString();
      output += d.toString();
      process.stdout.write(line);
      logs?.push(line);
    };
    
    child.stdout.on("data", onStdoutData);
    child.stderr.on("data", onStderrData);

    // Handle spawn errors (like ENOENT)
    child.on("error", (error) => {
      const msg = `${cmd} spawn error: ${error.message}`;
      console.error(`${label} ${msg}`);
      logs?.push(`${label} ${msg}\n`);
      reject(new Error(msg));
    });

    child.on("exit", (code) => {
      if (code === 0) {
        // Return both stdout and stderr for successful commands
        resolve({ stdout, stderr, output });
      } else {
        const msg = `${cmd} exited ${code}`;
        console.error(`${label} ${msg}`);
        logs?.push(`${label} ${msg}\n`);
        // Include the actual output in the error for validation parsing
        const error = new Error(msg);
        error.stdout = stdout;
        error.stderr = stderr;
        error.output = output;
        reject(error);
      }
    });
  });
}

/* ========= NPM install (robust) ========= */

async function npmInstall(dir, { id, storeDir, logs }) {
  const startTime = Date.now();
  console.log(`[${id}] Starting npm install... (Environment: ${IS_RAILWAY ? 'Railway' : 'Local'})`);

  await fs.mkdir(storeDir, { recursive: true });

  const env = {
    ...process.env,
    NODE_ENV: "development", // include devDependencies (Next)
    CI: "1", // non-interactive
  };

  const baseArgs = [
    "install",
    "--prefer-offline",
    "--legacy-peer-deps", // ✅ Allow installing with peer dependency conflicts
  ];

  // ✅ Add Railway-specific timeout handling
  const INSTALL_TIMEOUT = IS_RAILWAY ? 300000 : 120000; // 5 min for Railway, 2 min for local
  console.log(`[${id}] npm install timeout set to ${INSTALL_TIMEOUT}ms`);

  try {
    console.log(`[${id}] Running npm install with --prefer-offline...`);

    // ✅ Create a timeout promise
    const installPromise = run("npm", baseArgs, { id, cwd: dir, env, logs });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`npm install timeout after ${INSTALL_TIMEOUT}ms`)), INSTALL_TIMEOUT);
    });

    await Promise.race([installPromise, timeoutPromise]);
    console.log(`[${id}] ✅ npm install completed in ${Date.now() - startTime}ms`);
  } catch (error) {
    if (error.message.includes('timeout')) {
      console.error(`[${id}] ❌ npm install timed out after ${INSTALL_TIMEOUT}ms`);
      throw error;
    }

    console.log(`[${id}] npm install with --prefer-offline failed, retrying without...`);
    // fallback without --prefer-offline but keep --legacy-peer-deps
    const retry = baseArgs.filter((a) => a !== "--prefer-offline");

    const retryPromise = run("npm", retry, { id, cwd: dir, env, logs });
    const retryTimeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`npm install retry timeout after ${INSTALL_TIMEOUT}ms`)), INSTALL_TIMEOUT);
    });

    await Promise.race([retryPromise, retryTimeoutPromise]);
    console.log(`[${id}] ✅ npm install retry completed in ${Date.now() - startTime}ms`);
  }

  // Verify Next binary exists
  const nextBin = path.join(dir, "node_modules", ".bin", "next");
  if (!(await exists(nextBin))) {
    throw new Error(`[${id}] install finished but ".bin/next" is missing`);
  }

  console.log(`[${id}] 📦 Verified Next.js binary exists`);
}

async function needInstall(dir) {
  const nextBin = path.join(dir, "node_modules", ".bin", "next");
  return !(await exists(nextBin)); // install if Next is missing
}

/* ========= Preview registry & helpers ========= */

const previews = new Map(); // id -> { port, proc, dir, lastHit, status, logs, lastError }
const deploymentJobs = new Map(); // projectId -> { status, startTime, error, logs, deploymentUrl, platform }
const proxy = httpProxy.createProxyServer({ ws: true });

// prevent crashes on target errors
proxy.on("error", (err, req, res) => {
  console.error("proxy error:", err?.message || err);
  // Check if res is an HTTP response (has writeHead) vs WebSocket (socket)
  if (res && typeof res.writeHead === 'function' && !res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain" });
    return res.end(
      "Preview backend isn't reachable yet. Try again in a few seconds."
    );
  }
  try {
    req?.socket?.destroy?.();
    // For WebSocket connections, destroy the socket
    if (res && typeof res.destroy === 'function') {
      res.destroy();
    }
  } catch {}
});

let lastPort = BASE_PORT - 1;
function nextFreePort() {
  // simple rolling allocator across a 2k window
  for (let i = 0; i < 2000; i++) {
    const cand = ((lastPort + 1 - BASE_PORT + i) % 2000) + BASE_PORT;
    if (![...previews.values()].some((p) => p.port === cand)) {
      lastPort = cand;
      return cand;
    }
  }
  throw new Error("No free ports available");
}

// Helper function to kill any running processes for a project
function killProjectProcesses(projectId) {
  const preview = previews.get(projectId);
  if (preview && preview.proc) {
    try {
      console.log(`[${projectId}] Killing running process...`);
      preview.proc.kill("SIGTERM");
      // Wait a bit for graceful shutdown
      return new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      console.warn(`[${projectId}] Error killing process:`, err.message);
    }
  }
  return Promise.resolve();
}

async function copyBoilerplate(dst, boilerplateSrc = null) {
  const startTime = Date.now();
  // Use provided source or default to Farcaster boilerplate for backward compatibility
  const BOILERPLATE = boilerplateSrc || FARCASTER_BOILERPLATE;
  console.log(`[copyBoilerplate] Starting boilerplate copy from ${BOILERPLATE} to ${dst}...`);
  
  try {
    await fs.mkdir(dst, { recursive: true });
    
    // copy while excluding build dirs & node_modules
    await run("sh", [
      "-lc",
      `tar -C ${BOILERPLATE} \
        --exclude=.git --exclude=node_modules --exclude=.next --exclude=.turbo --exclude=dist --exclude=build \
        -cf - . | tar -C ${dst} -xpf -`,
    ]);
    
    // safety: ensure none of these exist post-copy
    for (const d of ["node_modules", ".next", ".turbo", "dist", "build"]) {
      await fs.rm(path.join(dst, d), { recursive: true, force: true });
    }
    
    console.log(`[copyBoilerplate] Boilerplate copy completed in ${Date.now() - startTime}ms`);
  } catch (error) {
    console.error(`[copyBoilerplate] Failed to copy boilerplate:`, error);
    // If tar failed, try a simpler approach with fs.cp
    console.log(`[copyBoilerplate] Retrying with fs.cp...`);
    try {
      await fs.cp(BOILERPLATE, dst, { 
        recursive: true,
        filter: (src) => {
          // Exclude certain directories
          const basename = path.basename(src);
          return !['node_modules', '.next', '.turbo', 'dist', 'build', '.git'].includes(basename);
        }
      });
      console.log(`[copyBoilerplate] Boilerplate copy completed with fs.cp in ${Date.now() - startTime}ms`);
    } catch (retryError) {
      console.error(`[copyBoilerplate] Failed to copy boilerplate with fs.cp:`, retryError);
      throw new Error(`Failed to copy boilerplate: ${retryError.message}`);
    }
  }
}

async function writeFiles(dir, files) {
  if (!Array.isArray(files)) return;
  
  // Write files in batches to prevent file descriptor exhaustion and race conditions
  const BATCH_SIZE = 10; // Process 10 files at a time
  const batches = [];
  
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    batches.push(files.slice(i, i + BATCH_SIZE));
  }
  
  console.log(`[writeFiles] Writing ${files.length} files in ${batches.length} batches of ${BATCH_SIZE}...`);
  
  // Process batches sequentially to avoid overwhelming the file system
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    await Promise.all(
      batch.map(async (f) => {
        try {
          const full = path.join(dir, f.path);
          await fs.mkdir(path.dirname(full), { recursive: true });
          await fs.writeFile(full, f.content, "utf8");
        } catch (error) {
          console.error(`[writeFiles] Failed to write ${f.path}:`, error.message);
          throw error; // Re-throw to fail the deployment
        }
      })
    );
  }
  
  console.log(`[writeFiles] Successfully wrote all ${files.length} files`);
}

function startDev(id, dir, port, logs) {
  const startTime = Date.now();
  console.log(`[${id}] Starting Next.js dev server on port ${port}...`);
  
  const env = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(port),
    ASSET_PREFIX: `/p/${id}`,
  };

  // Use npx to call next dev directly
  const proc = spawn(
    "npx",
    ["next", "dev", "-p", String(port), "-H", "127.0.0.1"],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] }
  );

  const onData = (d) => {
    const line = `[${id}] ${d.toString()}`;
    process.stdout.write(line);
    logs?.push(line);
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  proc.on("exit", (code, signal) => {
    const p = previews.get(id);
    if (!p) return;
    p.status = "crashed";
    p.lastError = `dev exited code=${code} signal=${signal}`;
    previews.delete(id);
  });

  return proc;
}

function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next();
  const hdr = req.headers["authorization"] || "";
  if (hdr === `Bearer ${AUTH_TOKEN}`) return next();
  res.status(401).json({ error: "unauthorized" });
}

function waitForReady(port, timeoutMs = 1000000) {
  const start = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/", timeout: 1500 },
        (res) => {
          res.resume();
          resolve(true);
        }
      );
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(tryOnce, 300);
      });
      req.on("timeout", () => {
        try {
          req.destroy(new Error("timeout"));
        } catch {}
      });
    };
    tryOnce();
  });
}

/* ========= App & routes ========= */

const app = express();
const server = http.createServer(app);

app.use(bodyParser.json({ limit: "50mb" }));

// Validation endpoint for compilation validation
app.post("/validate", requireAuth, async (req, res) => {
  const validationStartTime = Date.now();
  const projectId = req.body.projectId || req.body.hash;
  const files = req.body.files;
  const isWeb3 = req.body.isWeb3 || false; // Get app type from request
  
  // Railway-specific: Force disable heavy validation to avoid memory issues
  // Override client config on Railway - validation is already done on frontend
  const validationConfig = IS_RAILWAY ? {
    enableTypeScript: true,  // Force skip - memory intensive
    enableSolidity: true,    // Force skip - memory intensive  
    enableESLint: true,      // Force skip - memory intensive
    enableBuild: true,       // Force skip - memory intensive
    enableRuntimeChecks: true // Keep - lightweight
  } : (req.body.validationConfig || {
    enableTypeScript: true,
    enableSolidity: true,
    enableESLint: true,
    enableBuild: true,
    enableRuntimeChecks: true
  });
  
  if (!projectId) return res.status(400).json({ error: "projectId required" });
  if (!files) return res.status(400).json({ error: "files required" });

  console.log(`[${projectId}] Starting compilation validation... (Environment: ${IS_RAILWAY ? 'Railway' : 'Local'})`);
  console.log(`[${projectId}] App Type: ${isWeb3 ? 'Web3' : 'Farcaster'}`);
  console.log(`[${projectId}] Validation config:`, validationConfig);
  
  try {
    // Convert files object to array format
    const filesArray = Object.entries(files || {}).map(([path, content]) => ({
      path,
      content
    }));

    console.log(`[${projectId}] Processing ${filesArray.length} files for validation`);

    // Run full compilation validation using Railway validator - use correct boilerplate
    const boilerplatePath = getBoilerplatePath(isWeb3);
    console.log(`[${projectId}] Using boilerplate for validation: ${boilerplatePath}`);
    const validator = new RailwayCompilationValidator(process.cwd(), boilerplatePath, PREVIEWS_ROOT, npmInstall);
    const validationResult = await validator.validateProject(projectId, filesArray, validationConfig, run);
    
    console.log(`[${projectId}] Validation completed in ${Date.now() - validationStartTime}ms`);
    console.log(`[${projectId}] Success: ${validationResult.success}, Errors: ${validationResult.errors.length}, Warnings: ${validationResult.warnings.length}`);
    
    return res.json(validationResult);
    
  } catch (e) {
    console.error(`[${projectId}] Validation failed after ${Date.now() - validationStartTime}ms:`, e);
    return res.status(500).json({ 
      success: false,
      error: String(e.message || e),
      errors: [],
      warnings: [{
        file: 'validation',
        line: 1,
        message: `Validation failed: ${e.message}`,
        severity: 'error',
        category: 'validation',
        suggestion: 'Check Railway logs for details'
      }],
      compilationTime: Date.now() - validationStartTime,
      validationSummary: {
        totalFiles: 0,
        filesWithErrors: 0,
        filesWithWarnings: 0,
        criticalErrors: 1
      }
    });
  }
});

// Contract deployment endpoint - deploys contracts BEFORE app deployment
app.post("/deploy-contracts", requireAuth, async (req, res) => {
  const deployStartTime = Date.now();
  const { projectId, files } = req.body;

  if (!projectId) {
    return res.status(400).json({
      success: false,
      error: "projectId required"
    });
  }

  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({
      success: false,
      error: "files array required"
    });
  }

  console.log(`[${projectId}] 🔗 Contract deployment requested...`);
  console.log(`[${projectId}] Environment: ${IS_RAILWAY ? 'Railway' : 'Local'}`);

  try {
    // Check if contract deployment is enabled
    if (!ENABLE_CONTRACT_DEPLOYMENT) {
      return res.status(400).json({
        success: false,
        error: "Contract deployment is not enabled. Set ENABLE_CONTRACT_DEPLOYMENT=true"
      });
    }

    if (!PRIVATE_KEY) {
      return res.status(400).json({
        success: false,
        error: "Contract deployment requires PRIVATE_KEY environment variable"
      });
    }

    // Create temporary directory for contract deployment
    const tempDir = path.join(PREVIEWS_ROOT, `${projectId}-contracts-temp`);
    console.log(`[${projectId}] Creating temporary directory: ${tempDir}`);

    // Clean up if exists
    if (existsSync(tempDir)) {
      console.log(`[${projectId}] Cleaning existing temp directory...`);
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    // Copy boilerplate (use Web3 boilerplate as it has contract support)
    console.log(`[${projectId}] Setting up contract deployment environment...`);
    await copyBoilerplate(tempDir, WEB3_BOILERPLATE);

    // Filter and write only contract-related files
    const contractFiles = files.filter(f =>
      f.path.startsWith('contracts/') ||
      f.path.includes('hardhat.config') ||
      f.path.startsWith('scripts/') ||
      f.path === 'package.json'
    );

    if (contractFiles.length === 0) {
      await fs.rm(tempDir, { recursive: true, force: true });
      return res.status(400).json({
        success: false,
        error: "No contract files found in project"
      });
    }

    console.log(`[${projectId}] Writing ${contractFiles.length} contract files...`);
    await writeFiles(tempDir, contractFiles);

    // Deploy contracts using existing function
    const logs = makeRing();
    console.log(`[${projectId}] Starting contract compilation and deployment...`);

    const contractDeploymentInfo = await deployContracts(
      tempDir,
      projectId,
      logs,
      false // don't skip contracts
    );

    // Clean up temp directory
    console.log(`[${projectId}] Cleaning up temporary directory...`);
    await fs.rm(tempDir, { recursive: true, force: true });

    if (!contractDeploymentInfo) {
      return res.status(500).json({
        success: false,
        error: "Contract deployment returned no deployment info"
      });
    }

    const deploymentTime = Date.now() - deployStartTime;
    console.log(`[${projectId}] ✅ Contracts deployed successfully in ${deploymentTime}ms`);
    console.log(`[${projectId}] Contract addresses:`, JSON.stringify(contractDeploymentInfo, null, 2));

    return res.json({
      success: true,
      contractAddresses: contractDeploymentInfo,
      network: 'baseSepolia',
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      deploymentTime,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error(`[${projectId}] ❌ Contract deployment failed after ${Date.now() - deployStartTime}ms:`, error);

    // Clean up temp directory on error
    const tempDir = path.join(PREVIEWS_ROOT, `${projectId}-contracts-temp`);
    if (existsSync(tempDir)) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(`[${projectId}] Failed to cleanup temp directory:`, cleanupError);
      }
    }

    return res.status(500).json({
      success: false,
      error: error.message || "Contract deployment failed",
      details: error.stack
    });
  }
});

// Deploy endpoint with external deployment feature flags
app.post("/deploy", requireAuth, async (req, res) => {
  const deployStartTime = Date.now();
  const projectId = req.body.hash;
  const files = req.body.files;
  const wait = req.body.wait ?? true; // default: wait for readiness
  const deployToExternal = req.body.deployToExternal; // platform: "vercel" | "netlify" | undefined
  const isWeb3 = req.body.isWeb3;
  const skipContracts = req.body.skipContracts ?? false; // default: false (deploy contracts if they exist)
  const jobId = req.body.jobId; // Job ID for background deployment error reporting

  if (!projectId) return res.status(400).json({ error: "hash required" });
  if (!files) return res.status(400).json({ error: "files required" });

  console.log(`[${projectId}] Starting deploy process... (Environment: ${IS_RAILWAY ? 'Railway' : 'Local'})`);
  console.log(`[${projectId}] Deploy flags: isWeb3=${isWeb3}, skipContracts=${skipContracts}`);
  
  try {
    // Convert files object to array format
    const filesArray = Object.entries(files || {}).map(([path, content]) => ({
      path,
      content
    }));

    // Railway-specific: Force external deployment if configured
    const effectiveDeployToExternal = IS_RAILWAY && FORCE_EXTERNAL_DEPLOYMENT 
      ? (deployToExternal || "vercel")  // Default to Vercel on Railway
      : deployToExternal;

    // Check if external deployment is requested and enabled
    const shouldDeployExternal = effectiveDeployToExternal && 
      (effectiveDeployToExternal === "vercel" || effectiveDeployToExternal === "netlify");
    
    if (shouldDeployExternal &&
        ((effectiveDeployToExternal === "vercel" && ENABLE_VERCEL_DEPLOYMENT) ||
         (effectiveDeployToExternal === "netlify" && ENABLE_NETLIFY_DEPLOYMENT))) {
      console.log(`[${projectId}] External deployment requested to ${effectiveDeployToExternal}`);
      return await handleExternalDeployment(projectId, filesArray, effectiveDeployToExternal, skipContracts, res, deployStartTime, jobId, isWeb3);
    }

    // Railway-specific: Return error if external deployment not available
    if (IS_RAILWAY && FORCE_EXTERNAL_DEPLOYMENT) {
      return res.status(400).json({
        error: "External deployment required on Railway. Please configure Vercel or Netlify deployment.",
        suggestion: "Set ENABLE_VERCEL_DEPLOYMENT=true and DEPLOYMENT_TOKEN_SECRET, or ENABLE_NETLIFY_DEPLOYMENT=true and NETLIFY_TOKEN"
      });
    }

    // Default: Local deployment flow (only for local environment)
    return await handleLocalDeployment(projectId, filesArray, wait, skipContracts, res, deployStartTime, isWeb3);
    
  } catch (e) {
    console.error(`[${projectId}] Deploy failed after ${Date.now() - deployStartTime}ms:`, e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Handle external deployment logic
async function handleExternalDeployment(projectId, filesArray, platform, skipContracts, res, deployStartTime, jobId, isWeb3 = false) {
  try {
    console.log(`[${projectId}] Starting external deployment to ${platform}...`);
    console.log(`[${projectId}] JobId: ${jobId || 'not provided'}`);
    console.log(`[${projectId}] App Type: ${isWeb3 ? 'Web3' : 'Farcaster'}`);
    
    // Initialize deployment job in tracking map
    deploymentJobs.set(projectId, {
      status: 'in_progress',
      startTime: deployStartTime,
      platform,
      error: null,
      logs: '',
      deploymentUrl: null,
      jobId // Store jobId for error reporting
    });

    const dir = path.join(PREVIEWS_ROOT, `${projectId}-${platform}`);

    // Clean existing directory
    if (existsSync(dir)) {
      console.log(`[${projectId}] Cleaning existing deployment directory with retry logic...`);
      // Retry up to 3 times with exponential backoff
      let cleaned = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
          cleaned = true;
          console.log(`[${projectId}] Directory cleaned successfully on attempt ${attempt}`);
          break;
        } catch (cleanError) {
          console.warn(`[${projectId}] Clean attempt ${attempt}/3 failed:`, cleanError.message);
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      if (!cleaned) {
        console.warn(`[${projectId}] Could not clean directory, will overwrite files instead`);
        // Don't throw - we'll try to overwrite instead
      }
    }

    // Copy boilerplate and write files - use correct boilerplate based on app type
    const boilerplatePath = getBoilerplatePath(isWeb3);
    console.log(`[${projectId}] Using boilerplate: ${boilerplatePath}`);
    await copyBoilerplate(dir, boilerplatePath);
    await writeFiles(dir, filesArray);

    // Remove pnpm-lock.yaml to force npm usage
    const pnpmLockPath = path.join(dir, 'pnpm-lock.yaml');
    if (existsSync(pnpmLockPath)) {
      console.log(`[${projectId}] Removing pnpm-lock.yaml to force npm usage`);
      await fs.rm(pnpmLockPath, { force: true });
    }

    const logs = makeRing();
    
    // Railway-specific: Skip npm install for external deployments
    // Vercel/Netlify will handle dependency installation with more resources
    if (!IS_RAILWAY || !FORCE_EXTERNAL_DEPLOYMENT) {
      console.log(`[${projectId}] Installing dependencies locally...`);
      await npmInstall(dir, { id: projectId, storeDir: PNPM_STORE, logs });
    } else {
      console.log(`[${projectId}] Skipping npm install - ${platform} will handle it`);
    }

    // Deploy contracts to testnet if enabled
    let contractDeploymentInfo = null;
    
    // Railway-specific: Skip contract deployment to avoid memory issues
    // Contracts require npm install which exceeds Railway memory limits
    if (IS_RAILWAY && FORCE_EXTERNAL_DEPLOYMENT) {
      console.log(`[${projectId}] ⚠️  Skipping contract deployment on Railway (memory constraints)`);
      console.log(`[${projectId}] Contracts will be deployed separately if needed`);
    } else {
      try {
        contractDeploymentInfo = await deployContracts(dir, projectId, logs, skipContracts);
        if (contractDeploymentInfo) {
          console.log(`[${projectId}] 📄 Contract deployment info saved`);
        }
      } catch (error) {
        console.error(`[${projectId}] ⚠️ Contract deployment skipped:`, error.message);
      }
    }

    // Deploy to platform with timeout for immediate response
    let deploymentUrl;
    let platformEnabled = false;
    
    // Wrap deployment in a promise that we can race against a timeout
    const deploymentPromise = (async () => {
      try {
        if (platform === "vercel" && ENABLE_VERCEL_DEPLOYMENT && DEPLOYMENT_TOKEN_SECRET) {
          deploymentUrl = await deployToVercel(dir, projectId, logs);
        platformEnabled = true;
      } else if (platform === "netlify" && ENABLE_NETLIFY_DEPLOYMENT && NETLIFY_TOKEN) {
        deploymentUrl = await deployToNetlify(dir, projectId, logs);
        platformEnabled = true;
      }
      
      return { deploymentUrl, platformEnabled };
      } catch (deploymentError) {
        throw deploymentError;
      }
    })();
    
    // Set a 2-minute threshold for immediate response
    // If deployment isn't done by then, return in_progress and continue in background
    const IMMEDIATE_RESPONSE_THRESHOLD = 120000; // 2 minutes
    const timeoutPromise = new Promise(resolve => 
      setTimeout(() => resolve({ timeout: true }), IMMEDIATE_RESPONSE_THRESHOLD)
    );
    
    const result = await Promise.race([deploymentPromise, timeoutPromise]);
    
    // If deployment completed within threshold, return success immediately
    if (!result.timeout) {
      deploymentUrl = result.deploymentUrl;
      platformEnabled = result.platformEnabled;
      
      // Update job status to completed
      deploymentJobs.set(projectId, {
        status: 'completed',
        startTime: deployStartTime,
        platform,
        error: null,
        logs: logs.text(),
        deploymentUrl
      });
      
      console.log(`[${projectId}] Deployment completed within threshold (${Date.now() - deployStartTime}ms)`);
      // Fall through to success response below
    } else {
      // Deployment is taking too long, return in_progress and continue in background
      console.log(`[${projectId}] Deployment exceeded ${IMMEDIATE_RESPONSE_THRESHOLD}ms threshold, returning in_progress...`);
      
      // Continue deployment in background
      deploymentPromise.then(bgResult => {
        deploymentUrl = bgResult.deploymentUrl;
        platformEnabled = bgResult.platformEnabled;
        
        // Update job status
        deploymentJobs.set(projectId, {
          status: 'completed',
          startTime: deployStartTime,
          platform,
          error: null,
          logs: logs.text(),
          deploymentUrl
        });
        
        console.log(`[${projectId}] Background deployment completed in ${Date.now() - deployStartTime}ms`);
      }).catch(async (bgError) => {
        const errorLogs = logs.text();
        
        // Update job with error
        deploymentJobs.set(projectId, {
          status: 'failed',
          startTime: deployStartTime,
          platform,
          error: bgError.message,
          logs: errorLogs,
          deploymentUrl: null,
          jobId
        });
        
        console.error(`[${projectId}] Background deployment failed:`, bgError.message);
        
        // Notify miniapp-creator to update job status to failed
        const deploymentJob = deploymentJobs.get(projectId);
        if (deploymentJob && deploymentJob.jobId) {
          await notifyJobFailure(deploymentJob.jobId, projectId, bgError.message, errorLogs);
        }
      });
      
      // Return in_progress response immediately
      return res.json({
        success: true,
        status: 'in_progress',
        projectId,
        platform,
        message: 'Deployment in progress, poll /deploy/status/:projectId for updates',
        estimatedTime: '2-5 minutes'
      });
    }
    
    // For deployments that completed within threshold, check if platform was enabled
    if (!platformEnabled) {
      console.log(`[${projectId}] ${platform} deployment disabled or not configured, falling back to local`);
      return handleLocalDeployment(projectId, filesArray, true, skipContracts, res, deployStartTime, isWeb3);
    }

    // Register external deployment in previews map for updates
    const rec = {
      port: null,
      proc: null,
      dir,
      lastHit: Date.now(),
      status: "deployed",
      logs,
      lastError: null,
      externalPlatform: platform,
      deploymentUrl
    };
    previews.set(projectId, rec);
    console.log(`[${projectId}] Registered external deployment in previews map`);

    console.log(`[${projectId}] External deployment completed in ${Date.now() - deployStartTime}ms`);
    return res.json({
      success: true,
      previewUrl: deploymentUrl,
      vercelUrl: deploymentUrl,
      externalDeployment: true,
      platform,
      aliasSuccess: true,
      isNewDeployment: true,
      hasPackageChanges: true,
      status: "completed",
      contractDeployment: contractDeploymentInfo
    });

  } catch (e) {
    console.error(`[${projectId}] External deployment failed:`, e);
    
    // Capture deployment logs for error analysis (logs may not be defined if error happens early)
    const deploymentLogs = typeof logs !== 'undefined' && logs.text ? logs.text() : '';
    const errorOutput = e.output || e.stdout || e.stderr || '';
    
    return res.status(500).json({
      success: false,
      error: `External deployment to ${platform} failed: ${e.message}`,
      details: e.stack,
      logs: deploymentLogs,
      output: errorOutput
    });
  }
}

// Handle local deployment logic
async function handleLocalDeployment(projectId, filesArray, wait, skipContracts, res, deployStartTime, isWeb3 = false) {
  try {
    console.log(`[${projectId}] Starting local deployment...`);
    console.log(`[${projectId}] App Type: ${isWeb3 ? 'Web3' : 'Farcaster'}`);
    
    // If running, patch files and return
    if (previews.has(projectId)) {
      const running = previews.get(projectId);
      await writeFiles(running.dir, filesArray);
      running.lastHit = Date.now();
      return res.json({
        previewUrl: `localhost:${PORT}/p/${projectId}`,
        vercelUrl: `localhost:${PORT}/p/${projectId}`,
        aliasSuccess: true,
        isNewDeployment: false,
        hasPackageChanges: false,
        status: running.status || "running",
        port: running.port,
      });
    }

    const dir = path.join(PREVIEWS_ROOT, projectId);

    // Kill any running processes first
    await killProjectProcesses(projectId);

    // Clean slate (avoid stale node_modules prompts)
    if (existsSync(dir)) {
      console.log(`[${projectId}] Cleaning existing directory with retry logic...`);
      // Retry up to 3 times with exponential backoff
      let cleaned = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
          cleaned = true;
          console.log(`[${projectId}] Directory cleaned successfully on attempt ${attempt}`);
          break;
        } catch (cleanError) {
          console.warn(`[${projectId}] Clean attempt ${attempt}/3 failed:`, cleanError.message);
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      if (!cleaned) {
        console.warn(`[${projectId}] Could not clean directory, will overwrite files instead`);
        // Don't throw - we'll try to overwrite instead
      }
    }

    // Fresh: copy boilerplate, write deltas - use correct boilerplate based on app type
    console.log(`[${projectId}] Setting up fresh local preview...`);
    const boilerplatePath = getBoilerplatePath(isWeb3);
    console.log(`[${projectId}] Using boilerplate: ${boilerplatePath}`);
    await copyBoilerplate(dir, boilerplatePath);
    await writeFiles(dir, filesArray);

    // Install (always on fresh create)
    const logs = makeRing();
    await npmInstall(dir, { id: projectId, storeDir: PNPM_STORE, logs });

    // Deploy contracts to testnet if enabled
    let contractDeploymentInfo = null;
    try {
      contractDeploymentInfo = await deployContracts(dir, projectId, logs, skipContracts);
      if (contractDeploymentInfo) {
        console.log(`[${projectId}] 📄 Contract deployment info saved`);
      }
    } catch (error) {
      console.error(`[${projectId}] ⚠️ Contract deployment skipped:`, error.message);
    }

    // Start dev (record BEFORE spawn to avoid races)
    const port = nextFreePort();
    const rec = {
      port,
      proc: null,
      dir,
      lastHit: Date.now(),
      status: "starting",
      logs,
      lastError: null,
    };
    previews.set(projectId, rec);
    const proc = startDev(projectId, dir, port, logs);
    rec.proc = proc;

    if (wait) {
      console.log(`[${projectId}] Waiting for dev server to be ready...`);
      const waitStartTime = Date.now();
      const ok = await waitForReady(port, 1000000);
      console.log(`[${projectId}] Dev server ready check took ${Date.now() - waitStartTime}ms`);
      
      if (!ok) {
        previews.delete(projectId);
        return res.status(500).json({
          error: "dev did not become ready in time",
          status: "starting",
          logs: logs.text().slice(-4000),
        });
      }
      rec.status = "running";
      console.log(`[${projectId}] Local deployment completed successfully in ${Date.now() - deployStartTime}ms`);
      return res.json({ 
        previewUrl: `localhost:${PORT}/p/${projectId}`,
        vercelUrl: `localhost:${PORT}/p/${projectId}`,
        aliasSuccess: true,
        isNewDeployment: true,
        hasPackageChanges: true,
        status: "running", 
        port,
        contractDeployment: contractDeploymentInfo
      });
    }

    console.log(`[${projectId}] Local deploy completed (no wait) in ${Date.now() - deployStartTime}ms`);
    return res.json({ 
      previewUrl: `localhost:${PORT}/p/${projectId}`,
      vercelUrl: `localhost:${PORT}/p/${projectId}`,
      aliasSuccess: true,
      isNewDeployment: true,
      hasPackageChanges: true,
      status: "starting", 
      port 
    });
  } catch (e) {
    console.error(`[${projectId}] Local deployment failed after ${Date.now() - deployStartTime}ms:`, e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}

// Create/patch preview
app.post("/previews", requireAuth, async (req, res) => {
  const id = req.body.id;
  const files = req.body.files;
  const validationResult = req.body.validationResult; // NEW: Optional validation result
  const wait = req.body.wait ?? true; // default: wait for readiness
  const isWeb3 = req.body.isWeb3 || false; // Get app type from request
  if (!id) return res.status(400).json({ error: "id required" });

  // NEW: Check validation result before allowing deployment
  if (validationResult && !validationResult.success) {
    console.error(`[${id}] ❌ Validation failed - blocking deployment`);
    console.error(`[${id}] ❌ Errors: ${validationResult.errors.length}`);
    console.error(`[${id}] ⚠️  Warnings: ${validationResult.warnings.length}`);
    
    return res.status(400).json({
      error: "Validation failed - cannot deploy files with compilation errors",
      validationErrors: validationResult.errors,
      validationWarnings: validationResult.warnings,
      success: false
    });
  }

  try {
    // If running, patch files and return
    if (previews.has(id)) {
      const running = previews.get(id);

      // Check if this is an external deployment
      if (running.externalPlatform) {
        console.log(`[${id}] 🔄 Updating ${running.externalPlatform} deployment with file patches...`);
        try {
          // Update files in external deployment directory
          await writeFiles(running.dir, files);

          // Trigger platform redeploy
          const logs = makeRing();
          let deploymentUrl;

          if (running.externalPlatform === "vercel") {
            deploymentUrl = await deployToVercel(running.dir, id, logs);
          } else if (running.externalPlatform === "netlify") {
            deploymentUrl = await deployToNetlify(running.dir, id, logs);
          }

          running.lastHit = Date.now();
          running.deploymentUrl = deploymentUrl;

          console.log(`[${id}] ✅ ${running.externalPlatform} deployment updated successfully: ${deploymentUrl}`);

          return res.json({
            url: deploymentUrl,
            status: "deployed",
            platform: running.externalPlatform,
            vercelUrl: deploymentUrl,
            deploymentUpdated: true,
          });
        } catch (deploymentError) {
          console.error(`[${id}] ⚠️ ${running.externalPlatform} update failed:`, deploymentError.message);
          return res.status(500).json({
            error: `${running.externalPlatform} deployment update failed: ${deploymentError.message}`
          });
        }
      }

      // Local deployment update (only for local environment)
      if (IS_LOCAL) {
        await writeFiles(running.dir, files);
        running.lastHit = Date.now();

        return res.json({
          url: `/p/${id}`,
          status: running.status || "running",
          port: running.port,
        });
      }

      // Railway: No local deployments
      return res.status(400).json({
        error: "Local previews not supported on Railway. Use external deployment."
      });
    }

    // Railway-specific: No local preview creation
    if (IS_RAILWAY && FORCE_EXTERNAL_DEPLOYMENT) {
      return res.status(400).json({
        error: "Local previews not supported on Railway. Use external deployment."
      });
    }

    // Local environment: Create new local preview
    const dir = path.join(PREVIEWS_ROOT, id);

    // Kill any running processes first
    await killProjectProcesses(id);

    // Clean slate (avoid stale node_modules prompts)
    if (existsSync(dir)) {
      console.log(`[${id}] Cleaning existing directory with retry logic...`);
      // Retry up to 3 times with exponential backoff
      let cleaned = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
          cleaned = true;
          break;
        } catch (cleanError) {
          console.warn(`[${id}] Clean attempt ${attempt}/3 failed:`, cleanError.message);
          if (attempt < 3) {
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
          }
        }
      }
      if (!cleaned) {
        console.warn(`[${id}] Could not clean directory, will overwrite files instead`);
        // Don't throw - we'll try to overwrite instead
      }
    }

    // Fresh: copy boilerplate, write deltas - use correct boilerplate based on app type
    const boilerplatePath = getBoilerplatePath(isWeb3);
    console.log(`[${id}] Using boilerplate: ${boilerplatePath}`);
    await copyBoilerplate(dir, boilerplatePath);
    await writeFiles(dir, files);

    // Install (always on fresh create)
    const logs = makeRing();
    await npmInstall(dir, { id, storeDir: PNPM_STORE, logs });

    // Start dev (record BEFORE spawn to avoid races)
    const port = nextFreePort();
    const rec = {
      port,
      proc: null,
      dir,
      lastHit: Date.now(),
      status: "starting",
      logs,
      lastError: null,
    };
    previews.set(id, rec);
    const proc = startDev(id, dir, port, logs);
    rec.proc = proc;

    if (wait) {
      const ok = await waitForReady(port, 1000000);
      if (!ok) {
        previews.delete(id);
        return res.status(500).json({
          error: "dev did not become ready in time",
          status: "starting",
          logs: logs.text().slice(-4000),
        });
      }
      rec.status = "running";
      return res.json({ url: `/p/${id}`, status: "running", port });
    }

    return res.json({ url: `/p/${id}`, status: "starting", port });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// Stop & delete preview (kills process + wipes folder)
app.delete("/previews/:id", requireAuth, async (req, res) => {
  const id = req.params.id;
  const p = previews.get(id);
  if (p) {
    try {
      p.proc.kill("SIGTERM");
    } catch {}
    previews.delete(id);
  }
  await fs.rm(path.join(PREVIEWS_ROOT, id), { recursive: true, force: true });
  res.json({ ok: true });
});

// Status & logs (for debugging)
app.get("/previews/:id/status", (req, res) => {
  const p = previews.get(req.params.id);
  if (!p) return res.status(404).json({ status: "not_found" });
  res.json({
    status: p.status || "unknown",
    port: p.port,
    dir: p.dir,
    lastError: p.lastError || null,
  });
});

app.get("/previews/:id/logs", (req, res) => {
  const p = previews.get(req.params.id);
  if (!p) return res.status(404).send("not_found");
  res.type("text/plain").send(p.logs?.text?.() || "");
});

// Deployment job status endpoint (for polling)
app.get("/deploy/status/:projectId", requireAuth, (req, res) => {
  const projectId = req.params.projectId;
  const job = deploymentJobs.get(projectId);
  
  if (!job) {
    return res.status(404).json({ 
      error: "Deployment job not found",
      projectId 
    });
  }
  
  const response = {
    projectId,
    status: job.status, // 'in_progress', 'completed', 'failed'
    startTime: job.startTime,
    duration: Date.now() - job.startTime,
    platform: job.platform
  };
  
  // Include result data based on status
  if (job.status === 'completed') {
    response.deploymentUrl = job.deploymentUrl;
    response.success = true;
  } else if (job.status === 'failed') {
    response.error = job.error;
    response.logs = job.logs;
    response.success = false;
  }
  
  console.log(`[${projectId}] Status check: ${job.status}`);
  res.json(response);
});

// Health check endpoint (Railway-specific)
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: new Date().toISOString(),
    platform: IS_RAILWAY ? "railway" : "local",
    environment: IS_RAILWAY ? "production" : "development",
    externalDeployments: previews.size,
    features: {
      vercelDeployment: ENABLE_VERCEL_DEPLOYMENT,
      netlifyDeployment: ENABLE_NETLIFY_DEPLOYMENT,
      contractDeployment: ENABLE_CONTRACT_DEPLOYMENT,
      forceExternalDeployment: FORCE_EXTERNAL_DEPLOYMENT,
      compilationValidation: true
    },
    validation: {
      available: true,
      typescript: true,
      solidity: true,
      eslint: true,
      build: true,
      runtimeChecks: true
    }
  });
});

// Proxy preview content (NO AUTH) + auto-restart if folder exists
app.use("/p/:id", async (req, res) => {
  const id = req.params.id;
  let p = previews.get(id);

  if (!p) {
    // Railway-specific: Redirect to external deployment if available
    if (IS_RAILWAY && FORCE_EXTERNAL_DEPLOYMENT) {
      return res.status(404).send("Preview not found. Use external deployment.");
    }

    const dir = path.join(PREVIEWS_ROOT, id);
    if (existsSync(dir)) {
      // Validate directory has required files before attempting restart
      const packageJsonPath = path.join(dir, 'package.json');
      const srcPath = path.join(dir, 'src');
      
      if (!existsSync(packageJsonPath) || !existsSync(srcPath)) {
        console.warn(`[${id}] Corrupted preview directory detected, cleaning up...`);
        try {
          await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
          console.log(`[${id}] Corrupted directory cleaned successfully`);
        } catch (cleanError) {
          console.error(`[${id}] Failed to clean corrupted directory:`, cleanError);
        }
        return res.status(404).send("Preview not found (corrupted directory was cleaned)");
      }

      const logs = makeRing();

      // ensure deps (safe if already present)
      if (await needInstall(dir)) {
        try {
          await npmInstall(dir, { id, storeDir: PNPM_STORE, logs });
        } catch (e) {
          return res
            .status(500)
            .send(`Auto-install failed: ${String(e.message || e)}`);
        }
      }

      const port = nextFreePort();
      p = {
        port,
        proc: null,
        dir,
        lastHit: Date.now(),
        status: "starting",
        logs,
        lastError: null,
      };
      previews.set(id, p);
      const proc = startDev(id, dir, port, logs);
      p.proc = proc;

      const ok = await waitForReady(port, 60000);
      if (!ok) {
        previews.delete(id);
        return res
          .status(503)
          .send("Preview is starting. Please retry in a few seconds.");
      }
      p.status = "running";
      console.log(`[${id}] auto-restarted on ${port}`);
    }
  }

  if (!p) return res.status(404).send("Preview not found");

  // Railway-specific: Redirect to external deployment URL
  if (IS_RAILWAY && p.externalPlatform && p.deploymentUrl) {
    return res.redirect(p.deploymentUrl);
  }

  // Local environment: Proxy to local dev server
  if (IS_LOCAL && p.port) {
    // Strip /p/:id before proxying to Next
    req.url = req.url.replace(`/p/${id}`, "") || "/";
    p.lastHit = Date.now();
    proxy.web(req, res, {
      target: `http://127.0.0.1:${p.port}`,
      changeOrigin: true,
    });
    return;
  }

  // Fallback
  return res.status(404).send("Preview not available");
});

// WebSocket (HMR) pass-through (NO AUTH)
server.on("upgrade", (req, socket, head) => {
  const m = req.url.match(/^\/p\/([^/]+)/);
  if (!m) return socket.destroy();
  const id = m[1];
  const p = previews.get(id);
  if (!p) return socket.destroy();
  proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${p.port}` });
});

// Command execution endpoint for AI context gathering
app.post("/previews/:id/execute", requireAuth, async (req, res) => {
  const id = req.params.id;
  const { command, args, workingDirectory = "." } = req.body;
  
  if (!command) {
    return res.status(400).json({ error: "Command is required" });
  }

  // Security: Only allow whitelisted commands
  const allowedCommands = [
    "grep", "find", "tree", "cat", "head", "tail", "wc", "ls", "pwd",
    "file", "which", "type", "dirname", "basename", "realpath"
  ];

  if (!allowedCommands.includes(command)) {
    return res.status(400).json({ 
      error: `Command '${command}' is not allowed`,
      allowedCommands 
    });
  }

  // Security: Limit arguments
  if (args && args.length > 10) {
    return res.status(400).json({ error: "Too many arguments" });
  }

  // Security: Check for dangerous patterns
  const dangerousPatterns = [
    /[;&|`$]/,           // Command chaining
    /\.\./,              // Directory traversal
    /\/etc\/|\/proc\/|\/sys\//, // System directories
    /rm\s|del\s|mv\s|cp\s/,     // File operations
    /wget|curl|nc\s|netcat/,    // Network operations
    /eval|exec|system/,         // Code execution
  ];

  const allArgs = args || [];
  for (const arg of allArgs) {
    if (dangerousPatterns.some(pattern => pattern.test(arg))) {
      return res.status(400).json({ 
        error: `Dangerous pattern detected in argument: ${arg}` 
      });
    }
  }

  try {
    const p = previews.get(id);
    if (!p) {
      return res.status(404).json({ error: "Preview not found" });
    }

    const projectDir = p.dir;
    const fullWorkingDir = path.join(projectDir, workingDirectory);
    
    // Security: Ensure working directory is within project
    if (!fullWorkingDir.startsWith(projectDir)) {
      return res.status(400).json({ error: "Working directory outside project bounds" });
    }

    if (!existsSync(fullWorkingDir)) {
      return res.status(400).json({ error: "Working directory does not exist" });
    }

    console.log(`[${id}] Executing command: ${command} ${allArgs.join(" ")}`);
    
    const startTime = Date.now();
    const result = await run(command, allArgs, { 
      id, 
      cwd: fullWorkingDir,
      env: { ...process.env, NODE_ENV: "development" }
    });
    const executionTime = Date.now() - startTime;

    console.log(`[${id}] Command completed in ${executionTime}ms`);

    res.json({
      success: true,
      command,
      args: allArgs,
      workingDirectory,
      executionTime,
      output: result
    });

  } catch (error) {
    console.error(`[${id}] Command execution failed:`, error);
    res.status(500).json({
      success: false,
      error: error.message || "Command execution failed",
      command,
      args: allArgs
    });
  }
});

/* ========= Idle reaper (optional; 30 min) ========= */

setInterval(() => {
  const now = Date.now();
  for (const [id, p] of previews.entries()) {
    if (now - p.lastHit > 30 * 60 * 1000) {
      try {
        p.proc.kill("SIGTERM");
      } catch {}
      previews.delete(id);
      console.log(`[${id}] reaped (idle)`);
    }
  }
}, 60 * 1000);

/* ========= Boot ========= */

const appStart = async () => {
  await fs.mkdir(PREVIEWS_ROOT, { recursive: true });
  await fs.mkdir(PNPM_STORE, { recursive: true });
  
  console.log(`Preview host starting on ${PORT}`);
  console.log(`Environment: ${IS_RAILWAY ? 'Railway' : 'Local'}`);
  console.log(`External deployment forced: ${FORCE_EXTERNAL_DEPLOYMENT}`);
  console.log(`Vercel enabled: ${ENABLE_VERCEL_DEPLOYMENT}`);
  console.log(`Netlify enabled: ${ENABLE_NETLIFY_DEPLOYMENT}`);
  console.log(`Contract deployment enabled: ${ENABLE_CONTRACT_DEPLOYMENT}`);
  console.log(`Farcaster boilerplate path: ${FARCASTER_BOILERPLATE}`);
  console.log(`Web3 boilerplate path: ${WEB3_BOILERPLATE}`);
  console.log(`Previews root: ${PREVIEWS_ROOT}`);
  
  // Verify Farcaster boilerplate exists
  if (!(await exists(FARCASTER_BOILERPLATE))) {
    console.error(`❌ FARCASTER BOILERPLATE DIRECTORY NOT FOUND: ${FARCASTER_BOILERPLATE}`);
    console.error(`   Please check:`);
    if (IS_LOCAL) {
      console.error(`   - Ensure the Farcaster boilerplate directory exists at: ${path.resolve(FARCASTER_BOILERPLATE)}`);
    } else {
      console.error(`   - Docker build included the Farcaster boilerplate`);
      console.error(`   - FARCASTER_BOILERPLATE_DIR environment variable is set correctly (should be /srv/boilerplate-farcaster)`);
      console.error(`   - Current FARCASTER_BOILERPLATE_DIR: ${process.env.FARCASTER_BOILERPLATE_DIR || 'not set'}`);
    }
    throw new Error(`Farcaster boilerplate directory not found: ${FARCASTER_BOILERPLATE}`);
  }
  console.log(`✅ Farcaster boilerplate directory verified`);
  
  // Verify Web3 boilerplate exists
  if (!(await exists(WEB3_BOILERPLATE))) {
    console.error(`❌ WEB3 BOILERPLATE DIRECTORY NOT FOUND: ${WEB3_BOILERPLATE}`);
    console.error(`   Please check:`);
    if (IS_LOCAL) {
      console.error(`   - Ensure the Web3 boilerplate directory exists at: ${path.resolve(WEB3_BOILERPLATE)}`);
    } else {
      console.error(`   - Docker build included the Web3 boilerplate`);
      console.error(`   - WEB3_BOILERPLATE_DIR environment variable is set correctly (should be /srv/boilerplate-web3)`);
      console.error(`   - Current WEB3_BOILERPLATE_DIR: ${process.env.WEB3_BOILERPLATE_DIR || 'not set'}`);
    }
    throw new Error(`Web3 boilerplate directory not found: ${WEB3_BOILERPLATE}`);
  }
  console.log(`✅ Web3 boilerplate directory verified`);
  
  server.listen(PORT, '0.0.0.0', () => console.log(`Listening on ${PORT}`));
};

appStart().catch((e) => {
  console.error("Fatal boot error:", e);
  process.exit(1);
});
